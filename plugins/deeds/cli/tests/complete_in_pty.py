"""Return the arguments parsed by real shells after native Tab completion."""

import json
import os
import pty
import select
import signal
import sys
import time

shell, script, directory, inputs_json = sys.argv[1:]
inputs = json.loads(inputs_json)
name = os.path.basename(shell)
flags = {"bash": ["--noprofile", "--norc", "-i"], "zsh": ["-f"], "fish": ["--no-config", "-i"]}[name]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(directory)
    os.environ.update(TERM="dumb" if name == "fish" else "xterm-256color", HOME=directory, INPUTRC="/dev/null", BASH_SILENCE_DEPRECATION_WARNING="1", COMPLETION_FILE=script)
    os.execv(shell, [name, *flags])


def receive(marker):
    output = b""
    deadline = time.monotonic() + 5
    while marker not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(repr(output))
        ready, _, _ = select.select([fd], [], [], remaining)
        if ready:
            output += os.read(fd, 65536)
    return output


try:
    if name == "fish":
        setup = "source \"$COMPLETION_FILE\"; function deeds; printf '__ARGV__'; printf '\\037%s' $argv; printf '\\036\\n'; end; printf '%s\\n' '__READY__'\n"
    else:
        init = "autoload -Uz compinit; compinit -D; " if name == "zsh" else ""
        setup = init + "source \"$COMPLETION_FILE\"; deeds(){ printf '__ARGV__'; printf '\\037%s' \"$@\"; printf '\\036\\n'; }; printf '%s\\n' '__READY__'\n"
    os.write(fd, setup.encode())
    receive(b"__READY__\r\n")
    results = []
    for line in inputs:
        os.write(fd, line.encode())
        output = receive(b"\x1e")
        record = output.split(b"__ARGV__\x1f", 1)[1].split(b"\x1e", 1)[0]
        results.append(record.decode().split("\x1f"))
    print(json.dumps(results))
finally:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    # Bash 3.2 can wait for terminal closure during exit.
    os.close(fd)
    os.waitpid(pid, 0)
