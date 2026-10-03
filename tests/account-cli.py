"""Regression check: password input must not echo, including fast pasted input."""
import os
import pty
import select
import subprocess
import time
import uuid
from urllib.parse import unquote, urlsplit

if not os.environ.get("TEST_DATABASE_URL"):
    raise SystemExit("TEST_DATABASE_URL is required for the account CLI check")

url = urlsplit(os.environ["TEST_DATABASE_URL"])
assert url.path == "/mingocell_test", "CLI check requires isolated mingocell_test database"
env = dict(os.environ, DB_HOST=url.hostname, DB_PORT=str(url.port or 5432),
           DB_NAME="mingocell_test", DB_USER=unquote(url.username or ""),
           DB_PASSWORD=unquote(url.password or ""))
master, slave = pty.openpty()
child = subprocess.Popen(
    ["node", "dist/cli/manage-account.js", "create", f"{uuid.uuid4()}@example.org", "admin"],
    stdin=slave, stdout=slave, stderr=slave, env=env,
)
os.close(slave)
output = b""
password = b"Hidden CLI test password 123!"
sent = 0
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.2)[0]:
            continue
        try:
            output += os.read(master, 4096)
        except OSError:
            break
        if sent == 0 and b"Password (" in output:
            os.write(master, password + b"\n")
            sent = 1
        if sent == 1 and b"Confirm password:" in output:
            os.write(master, password + b"\n")
            sent = 2
    assert child.wait(timeout=1) == 0, "Account CLI failed"
    assert password not in output, "Password was echoed to terminal"
    assert b"Account operation completed." in output, "Account creation did not complete"
    print("Account CLI creation and hidden password prompt passed")
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
