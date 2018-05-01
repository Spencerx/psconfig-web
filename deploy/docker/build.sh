
#I have to move most of the app under mca-admin so that docker won't complain about *outside of context*
echo "preparing mca-admin"
rm -rf mca-admin/tmp
mkdir mca-admin/tmp
cp -r ../../api mca-admin/tmp
rm -f mca-admin/tmp/api/config.js
rm -f mca-admin/tmp/api/auth.pub
rm -f mca-admin/tmp/api/auth.key
rm -f mca-admin/tmp/api/user.jwt

cp -r ../../ui mca-admin/tmp
cp -r ../../package.json mca-admin/tmp
rm -rf mca-admin/tmp/api/config
rm -f mca-admin/tmp/api/auth.pub
rm -f mca-admin/tmp/api/auth.key
rm -f mca-admin/tmp/api/user.jwt

docker build mca-admin -t perfsonar/mca-admin
if [ ! $? -eq 0 ]; then
    echo "failed to build"
    exit
fi

docker tag perfsonar/mca-admin perfsonar/mca-admin:3.0.3
docker push perfsonar/mca-admin:3.0.3

echo "preparing mca-pub"
rm -rf mca-pub/tmp
mkdir mca-pub/tmp
cp -r ../../api mca-pub/tmp
rm -f mca-pub/tmp/api/config.js
cp -r ../../package.json mca-pub/tmp
rm -rf mca-pub/tmp/api/config

docker build mca-pub -t perfsonar/mca-pub
if [ ! $? -eq 0 ]; then
    echo "failed to build"
    exit
fi

docker tag perfsonar/mca-pub perfsonar/mca-pub:3.0.3
docker push perfsonar/mca-pub:3.0.3
