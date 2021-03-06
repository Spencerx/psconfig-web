'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');
const async = require('async');
const request = require('request');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../../models');

function get_service_type(mc_type) {
    switch(mc_type) {
        case "perfsonarbuoy/bwctl": return "bwctl";
        case "perfsonarbuoy/owamp": return "owamp";
        case "traceroute": return "traceroute";
        case "pinger": return "ping";
        default: 
           logger.error("unknown meshconfig service type", mc_type);
    }
    return null;
}

function resolve_hosts(hostnames, cb) {
    db.Host.find({hostname: {$in: hostnames}}, function(err, hosts) {
        if(err) return cb(err);
        var ids = hosts.map(host=>host._id);
        cb(null, ids);
    });
}

//make sure all hosts exist
function ensure_hosts(hosts_info, tests, cb) {
    var service_types = [];
    /*
    tests.forEach( function( test ) {
        service_types.push( test.service_type );
        //service_types[ test.service_type ] = 1;

    });
    */

    async.eachSeries(hosts_info, function(host, next_host) {
        db.Host.findOne({hostname: host.hostname}, function(err, _host) {
            if(err) return next_host(err);

            if(_host) {
                logger.debug("host already exists", host.hostname);
                if(_host.lsid) {
                    if ( "sitename" in host ) {
                        var sitename = host.sitename;
                        if ( typeof sitename != "undefined" ) {
                            _host.desc = sitename;
                            _host.save();
                        }
                    }
                    return next_host();
                } else {
                    //for adhoc host, make sure we have all services listed
                    host.services.forEach(function(service) {
                        //look for the service
                        var found = false;
                        _host.services.forEach(function(_service) {
                            if(_service.type == service.type) found = true;
                        });
                        if(!found) {
                            logger.debug("adding service", service);
                            _host.services.push(service);
                        }
                    });
                    logger.debug("updating services");
                    _host.save(next_host);
                }
            } else {
                logger.debug("missing host found - inserting " + host.hostname);
                //var types = {};
                service_types.forEach(function(service) {
                    host.services.push({ "type": service });
                });
                db.Host.create(host, function(err, _host) {
                    if(err) return next_host(err);
                    logger.debug("created host");
                    logger.debug(JSON.stringify(_host, null, 4));
                    return next_host()
                });
            }
        });
    }, cb);
}

//make sure all hostgroups exist
function ensure_hostgroups(hostgroups, cb) {
    async.eachSeries(hostgroups, function(hostgroup, next_hostgroup) {
        //crude, but let's key by name for now..
        db.Hostgroup.findOne({name: hostgroup.name}, function(err, _hostgroup) {
            if(err) return next_hostgroup(err);

            if(_hostgroup) {
                logger.debug("hostgroup seems to already exists");
                hostgroup._id = _hostgroup._id;
                return next_hostgroup();
            } else {
                logger.debug("need to create hostgroup resolving hosts..", hostgroup._hosts);
                resolve_hosts(hostgroup._hosts, function(err, hosts) {
                    if(err) return next_hostgroup(err);
                    hostgroup.hosts = hosts;
                    logger.debug("creating hostgroup");
                    db.Hostgroup.create(hostgroup, function(err, _hostgroup) {
                        if(err) return next_hostgroup(err);
                        hostgroup._id = _hostgroup._id;
                        logger.debug(JSON.stringify(_hostgroup, null, 4));
                        next_hostgroup();
                    });
                });
            }
        });
    }, cb);
}

//make sure all testspecs exist
function ensure_testspecs(testspecs, cb) {
    async.eachSeries(testspecs, function(testspec, next_testspec) {
        //crude, but let's key by name for now..
        db.Testspec.findOne({name: testspec.name}, function(err, _testspec) {
            if(err) return next_testspec(err);

            if(_testspec) {
                logger.debug("testspec seems to already exists");
                testspec._id = _testspec._id;
                return next_testspec(); 
            } else {
                logger.debug("creating testspec");
                db.Testspec.create(testspec, function(err, _testspec) {
                    if(err) return next_testspec(err);
                    testspec._id = _testspec._id;
                    logger.debug(JSON.stringify(_testspec, null, 4));
                    next_testspec();
                });
            }
        });
    }, cb);
}

// remove extraneous test parameters
function remove_extraneous_test_parameters( spec ) {

    if ( typeof spec == "undefined" ) return spec;

    delete spec.session_count;
    delete spec.loss_threshold;
    delete spec.type;
    delete spec.force_bidirectional;

    return spec;
}

exports.import = function(url, sub, cb) {
    logger.debug("config importer", url);

    //load requested json
    request.get({url:url, json:true, timeout: 3000}, function(err, r, meshconfig) {
        if(err) return cb(err);
        if(r.statusCode != 200) return cb("non-200 response from "+url);
        exports._process_imported_config( meshconfig, sub, cb );


    }); //loading meshconfig json
}

exports._process_imported_config = function ( meshconfig, sub, cb, disable_ensure_hosts) {
    sub = sub.toString();
    var meshconfig_desc = meshconfig.description;

    var out = meshconfig;
    out = JSON.stringify( out, null, "\t" );

    // config_params holds parameters to pass back to the callback
    var config_params = {};
    if ( meshconfig_desc ) {
        config_params.description = meshconfig_desc;
    }

    // process central MAs
    var ma_url_obj = {};
    if ( "measurement_archives" in meshconfig ) {
        meshconfig.measurement_archives.forEach(function(ma) {
            if ( ! ( "archives" in config_params ) ) config_params.archives = [];
            ma_url_obj[ ma.write_url ] = 1;
        });
    }

    var ma_urls = Object.keys( ma_url_obj );
    config_params.archives = ma_urls;
    meshconfig.ma_urls = ma_urls;
    //meshconfig.config_params = config_params;

    //console.log("IMPORTER ma_urls", ma_urls);


    //process hosts
    var hosts_info = [];
    meshconfig.organizations.forEach(function(org) {
        org.sites.forEach(function(site) {
            if ( !( "hosts" in site ) ) return;
            site.hosts.forEach(function(host) {
                var services = [];

                if ( "measurement_archives" in host ) {
                    host.measurement_archives.forEach(function(ma) {
                        services.push({type: get_service_type(ma.type)});
                    });
                }

                var addr_array = [];
                for(var i in host.addresses) {
                    var addr = host.addresses[i];
                    addr_array.push( {
                        address: addr
                    } );

                }

                var host_info = {
                    services: services,
                    no_agent: false,
                    hostname: host.addresses[0],
                    sitename: host.description,
                    addresses: addr_array,
                    info: {},
                    communities: [],
                    admins: [sub.toString()]
                };
                if(host.toolkit_url && host.toolkit_url != "auto") host_info.toolkit_url = host.toolkit_url;
                hosts_info.push(host_info);
            });
        });
    });


    //process hostgroups / testspecs
    var hostgroups = [];
    var testspecs = [];
    var tests = [];


    var hosts_service_types = {};
    meshconfig.tests.forEach(function(test) {
        var member_type = test.members.type;
        if(member_type != "mesh") return cb("only mesh type is supported currently");

        var type = get_service_type(test.parameters.type);
        var hostgroup = {
            name: test.description+" Group",
            desc: "Imported by PWA importer",
            type: "static",
            service_type: type,
            admins: [sub.toString()],
            _hosts: test.members.members, //hostnames that needs to be converted to host id
        };
        hostgroups.push(hostgroup);

        test.parameters = remove_extraneous_test_parameters( test.parameters );

        var testspec = {
            name: test.description+" Testspecs",
            desc: "Imported by PWA importer",
            service_type: type,
            admins: [sub.toString()],
            specs: test.parameters,
        };
        testspecs.push(testspec);

        var hosts_obj = {};
        hostgroup._hosts.forEach( function( host )  {
            if (! ( host in hosts_service_types ) ) {
                hosts_service_types[ host ] = {};
            }
            hosts_service_types[ host ][ type ] = 1;
        });

        tests.push({
            name: test.description,
            //desc: "imported", //I don't think this is used anymore
            service_type: type ,
            mesh_type: "mesh", // TODO: allow other mesh_types
            enabled: true,
            nahosts: [],
            _agroup: hostgroup, //
            _testspec: testspec //tmp
        });
    });


    hosts_info.forEach( function( host ) {
        var hostname = host.hostname;        
        var host_types = hosts_service_types[ hostname ];
        if ( typeof host_types == "undefined" ) return;
        var types = Object.keys( host_types );
        types.forEach( function( type ) {            
            host.services.push( { "type": type } );
        });

    });


    //now do update (TODO - should I let caller handle this?)
    if (! disable_ensure_hosts ) {
        ensure_hosts(hosts_info, tests, function(err) {
            ensure_hostgroups(hostgroups, function(err) {
                ensure_testspecs(testspecs, function(err) {
                    //add correct db references
                    tests.forEach(function(test) {
                        test.agroup = test._agroup._id;
                        test.testspec = test._testspec._id;
                    });
                    cb(null, tests, config_params);
                });
            });
        });
    } else {
        cb(null, tests, config_params);

    }

}
