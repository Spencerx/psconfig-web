#This script is used by "service mca setup" to setup DB / access tokens, etc..

#initialize postgresql (with md5 host auth)
#su - postgres -c "/usr/pgsql-9.4/bin/initdb --auth-host=md5"
service postgresql92-postgresql initdb

#start postgresql
#chkconfig postgresql-9.4 on
#service postgresql-9.4 start #will fail if v8 is already running on port 5432
chkconfig postgresql92-postgresql on
service postgresql92-postgresql start #will fail if v8 is already running on port 5432

#create mca user/db
if [ ! -f /root/mca.pgpasswd ]; then
    echo $RANDOM.$RANDOM.$RANDOM > /root/mca.pgpasswd
    su - postgres -c "psql -c \"CREATE ROLE mca PASSWORD '$(cat /root/mca.pgpasswd)' CREATEDB INHERIT LOGIN;\""
    su - postgres -c "psql -c \"CREATE DATABASE mcadmin OWNER mca\""
    echo "//autogeneated by mca rpm" > /opt/mca/mca/api/config/db.js
    echo "module.exports = 'postgres://mca:$(cat /root/mca.pgpasswd)@localhost/mcadmin'" >> /opt/mca/mca/api/config/db.js
fi

#generate service tokens
if [ ! -f /opt/mca/auth/api/config/auth.pub ]; then
    cd /opt/mca/auth/api/config && ./genkey.sh
fi

if [ ! -f /opt/mca/mca/api/config/profile.jwt ]; then
    cd /opt/mca/auth/bin && ./auth.js issue --scopes '{ "mca": [] }' --sub 'mca_service' --out /opt/mca/mca/api/config/profile.jwt
fi

#need to disable mod_ssl default conf
mv /etc/httpd/conf.d/ssl.conf /etc/httpd/conf.d/ssl.conf.disabled

#now I should be able to start everything
#su - mca -c "pm2 start /opt/mca/mca/deploy/mca.json"
#su - mca -c "pm2 save"

#persist pm2 session over reboot
#TODO - this somehow hoses up the script when run from init script
#pm2 startup redhat -u mca

#install igtf certs
mkdir -p /etc/grid-security/certificates
cd /etc/grid-security/certificates && wget https://dist.igtf.net/distribution/current/accredited/igtf-preinstalled-bundle-classic.tar.gz && tar -xzf *.tar.gz

service httpd start
chkconfig httpd on

service mca start

