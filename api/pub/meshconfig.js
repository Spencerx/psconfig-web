'use strict';

//contrib
var express = require('express');
var router = express.Router();
var _ = require('underscore'); //used?
var winston = require('winston');
var async = require('async');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models');
var common = require('../common');

var profile_cache = null;
function load_profile(cb) {
    logger.info("reloading profiles");
    common.profile.getall(function(err, profiles) {
        if(err) logger.error(err);
        else profile_cache = profiles;
    });
}
//load profile for the first time
load_profile();
setInterval(load_profile, 10*60*1000); //reload every 10 minutes

//convert list of UIDs to list of profile objects
function resolve_users(uids) {
    var users = [];
    uids.forEach(function(uid) {
        users.push(profile_cache[uid]);  
    });
    return users;
}

function resolve_testspec(id, cb) {
    db.Testspec.findById(id).exec(cb);
}
function resolve_ma(host, next) {
    //find local MA
    //logger.debug("resolving ma");
    var local_ma = null;
    host.services.forEach(function(service) {
        if(service.type == "ma") local_ma = service;
    });
    
    //replace ma with the actual ma service
    async.eachSeries(host.services, function(service, next_service) {
        if(!service.ma || service.ma == host._id) {
            service.ma = local_ma; //use local if not set
            next_service();
        } else {
            //find the host
            resolve_host(service.ma, function(err, _host) {
                if(err) return next_service(err);
                //find the ma service 
                _host.services.forEach(function(_service) {
                    if(_service.type == "ma") service.ma = _service;
                });
                next_service();
            });
        }
    }, function(err) {
        next(err, host);
    });
}
function resolve_host(id, cb) {
    db.Host.findById(id).exec(function(err, host) {
        if(err) return cb(err);
        resolve_ma(host, cb);
    });
}
function resolve_hosts(ids, cb) {
    db.Host.find({_id: {$in: ids}}).lean().exec(function(err, hosts) {
        if(err) return cb(err);
        async.eachSeries(hosts, resolve_ma, function(err) {
            cb(err, hosts);
        });
    });
}
function resolve_hostgroup(id, cb) {
    db.Hostgroup.findById(id).exec(function(err, hostgroup) {
        if(err) return cb(err);
        if(!hostgroup) return cb("can't find hostgroup:"+id);
        if(hostgroup.type == "static") {
            resolve_hosts(hostgroup.hosts, function(err, hosts) {
                if(err) return cb(err);
                cb(null, hosts);
            }); 
        } else {
            logger.debug("resolving dynamic hostgroup");
            logger.debug(hostgroup.host_filter);
            logger.debug(hostgroup.service_type);
            common.dynamic.resolve(hostgroup.host_filter, hostgroup.service_type, cb);
        }
    });
}

function generate_members(hosts) {
    var members = [];
    hosts.forEach(function(host) {
        members.push(host.hostname);
    });
    return members;
}

function get_type(service_type) {
    switch(service_type) {
    case "bwctl": 
    case "owamp": 
        return "perfsonarbuoy/"+service_type;
    case "ping": 
        return "pinger";
    }
    return service_type; //no change
}

function generate_mainfo(service) {
    return {
        read_url: service.ma.locator,
        write_url: service.ma.locator,
        type: "perfsonarbuoy/"+service.type, 
    };
}

//synchronous function to construct meshconfig from admin config
exports.generate = function(config, opts, cb) {

    //catalog of all hosts referenced in member groups keyed by _id
    var host_catalog = {}; 

    //resolve all db entries first
    config.admins = resolve_users(config.admins);
    async.eachSeries(config.tests, function(test, next_test) {
        if(!test.enabled) return next_test();
        async.parallel([
            function(next) {
                //a group
                if(!test.agroup) return next();
                resolve_hostgroup(test.agroup, function(err, hosts) {
                    if(err) return next(err);
                    test.agroup = hosts;
                    hosts.forEach(function(host) { host_catalog[host._id] = host; });
                    next();
                });
            },
            function(next) {
                //b group
                if(!test.bgroup) return next();
                resolve_hostgroup(test.bgroup, function(err, res) {
                    if(err) return next(err);
                    resolve_hosts(res.recs, function(err, hosts) {
                        test.bgroup = hosts;
                        hosts.forEach(function(host) { host_catalog[host._id] = host; });
                        next();
                    });
                });
            },
            function(next) {
                if(!test.nahosts) return next();
                resolve_hosts(test.nahosts, function(err, hosts) {
                    if(err) return next(err);
                    test.nahosts = hosts;
                    hosts.forEach(function(host) { host_catalog[host._id] = host; });
                    next();
                });
            },
            function(next) {
                //star center
                if(!test.center) return next();
                resolve_host(test.center, function(err, host) {
                    if(err) return next(err);
                    test.ceneter = host;
                    host_catalog[host._id] = host;
                    next();
                });
            },
            function(next) {
                //testspec
                if(!test.testspec) return next();
                resolve_testspec(test.testspec, function(err, testspec) {
                    if(err) return next(err);
                    test.testspec = testspec;
                    next();
                });
            }
        ], next_test);
    }, function(err) {
        if(err) return logger.error(err);

        //meshconfig root template
        var mc = {
            organizations: [],
            tests: [],
            administrators: [],
            description: config.name + " / " + config.desc,
            //_debug: config //debug
        };
    
        //set meshconfig admins
        if(config.admins) config.admins.forEach(function(admin) {
            mc.administrators.push({name: admin.fullname, email: admin.email});
        });
    
        //convert services to sites/hosts entries
        //mca currently doesn't handle the concept of organization
        var org = {
            sites: [],
            administrators: [],
            //description: "",
        };

        //register sites(hosts)
        for(var id in host_catalog) {
            var _host = host_catalog[id];
            var host = {
                //administrators: [], //TODO host admins
                addresses: [ _host.hostname ], 
                measurement_archives: [ ], 
                description: _host.sitename,
                toolkit_url: _host.toolkit_url||"auto",
            };
            if(_host.no_agent) host.no_agent = 1;

            //create ma entry for each service
            _host.services.forEach(function(service) {
                if(service.type == "mp-bwctl") return;
                if(service.type == "ma") return;
                if(service.type == "mp-owamp") return;
                if(opts.ma_override) service.ma = {
                    locator: opts.ma_override
                }
                //service.ma is already resolved.. (local vs. remote)
                if(service.ma) {
                    host.measurement_archives.push(generate_mainfo(service));
                } else {
                    logger.error("NO MA service running for ");
                    logger.debug(service);
                }
            });

            var site = {
                hosts: [ host ],
                //administrators: [], //TODO site admins (not needed?)
                location: _host.location,
                //description: _host.sitename //needed?
            };
            org.sites.push(site);
        }
        mc.organizations.push(org);

        //now the most interesting part..
        config.tests.forEach(function(test) {
            if(!test.enabled) return;
            var members = {
                type: test.mesh_type
            };
            switch(test.mesh_type) { 
            case "disjoint":
                members.a_members = generate_members(test.agroup);
                members.b_members = generate_members(test.bgroup);
                break;
            case "mesh":
                members.members = generate_members(test.agroup);
                break;
            case "star":
                members.members = generate_members(test.agroup);
                if(test.center) members.center_address = test.center.hostname; // || test.center.ip;
                break;
            case "ordered_mesh": 
                members.members = generate_members(test.agroup);
                break;
            }
            if(test.nahosts && test.nahosts.length > 0) {
                members.no_agents = generate_members(test.nahosts);
            }

            var parameters = test.testspec.specs;
            parameters.type = get_type(test.service_type);
            mc.tests.push({
                members: members,
                parameters: parameters,
                description: test.name,
            });
        });

        //all done
        cb(null, mc);
    });

    //mc.debug = config;
}

