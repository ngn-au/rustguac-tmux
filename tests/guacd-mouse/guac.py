# Minimal Guacamole client for the guacd terminal tests. argv[1] is the
# mode: "mouse" (move, wheel up/down, left click, key x), "osc52" (watch for
# the clipboard guacd sends, then right-click: guacd pastes it locally),
# "stdin" (send text through the STDIN pipe stream).
import base64, socket, sys, threading, time
mode = sys.argv[1] if len(sys.argv) > 1 else 'mouse'
def enc(*a): return ','.join(f'{len(str(x))}.{x}' for x in a) + ';'
def read_instr(f):
    buf = b''
    while True:
        c = f.read(1)
        if not c: return None
        buf += c
        if c == b';':
            s = buf.decode(errors='replace'); parts = []; i = 0
            while i < len(s) - 1:
                j = s.index('.', i); n = int(s[i:j]); parts.append(s[j+1:j+1+n]); i = j + 1 + n + 1
            return parts
key = open('/tmp/k').read()
s = socket.create_connection(('127.0.0.1', 4822)); s.settimeout(20); f = s.makefile('rb')
s.sendall(enc('select', 'ssh').encode())
args = read_instr(f); assert args[0] == 'args', args
vals = [{'hostname': '127.0.0.1', 'port': '2222', 'username': 't', 'private-key': key,
         'terminal-type': 'xterm-256color'}.get(n, '') for n in args[1:]]
vals[0] = args[1]
s.sendall((enc('size', 1024, 768, 96) + enc('audio') + enc('video') + enc('image') + enc('connect', *vals)).encode())
clip_streams, clipboard = set(), []
def pump():
    while True:
        try: i = read_instr(f)
        except Exception: return
        if i is None: return
        if i[0] == 'sync': s.sendall(enc('sync', i[1]).encode())
        elif i[0] == 'clipboard': clip_streams.add(i[1])
        elif i[0] == 'blob' and i[1] in clip_streams: clipboard.append(base64.b64decode(i[2]).decode())
threading.Thread(target=pump, daemon=True).start()
time.sleep(3)
if mode == 'mouse':
    for m in [(100, 100, 0), (100, 100, 8), (100, 100, 0), (100, 100, 16), (100, 100, 0), (100, 100, 1), (100, 100, 0)]:
        s.sendall(enc('mouse', *m).encode()); time.sleep(0.2)
elif mode == 'osc52':
    print('clipboard from guacd:', ''.join(clipboard), flush=True)
    for m in [(100, 100, 4), (100, 100, 0)]:
        s.sendall(enc('mouse', *m).encode()); time.sleep(0.2)
elif mode == 'stdin':
    text = 'pasted\rline2'
    s.sendall((enc('pipe', 7, 'text/plain', 'STDIN') + enc('blob', 7, base64.b64encode(text.encode()).decode()) + enc('end', 7)).encode())
time.sleep(0.5)
s.sendall((enc('key', 120, 1) + enc('key', 120, 0)).encode())
time.sleep(3)
print('done', flush=True)
