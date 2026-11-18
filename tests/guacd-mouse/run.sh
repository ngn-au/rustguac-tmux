#!/bin/sh
# Patched guacd against a local sshd (see README.md).
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq openssh-server python3 >/dev/null
useradd -m -s /work/app.sh t
mkdir -p /home/t/.ssh /run/sshd
ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -f /tmp/k
cp /tmp/k.pub /home/t/.ssh/authorized_keys; chown -R t /home/t/.ssh; chmod 600 /home/t/.ssh/authorized_keys
/usr/sbin/sshd -p 2222 -o ListenAddress=127.0.0.1
export LD_LIBRARY_PATH=/opt/rustguac/lib
(/opt/rustguac/sbin/guacd -f -b 127.0.0.1 -l 4822 -L info > /tmp/guacd.log 2>&1 &)
sleep 1
for t in on:mouse off:mouse osc52:osc52 off:stdin; do
  mode=${t%%:*}; client=${t#*:}
  echo $mode > /tmp/mode; chmod 644 /tmp/mode; rm -f /tmp/got
  timeout 30 python3 /work/guac.py $client || echo "client failed"
  echo "== app $mode, client $client: app received:"; od -c /tmp/got 2>/dev/null | head -5
done
