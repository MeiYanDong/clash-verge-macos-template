"""Parse only; never evaluate shell text or mutate assignment/data values."""
import json
import pathlib
import re
import shlex
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / 'vendor'))
import bashlex


def rewrite(command, aliases, wrapper):
    # bashlex 0.18 cannot parse the reserved `time` production. Tokenize it
    # with the same parser and mask ONLY TIME tokens at identical offsets.
    # The original source (including time options) remains untouched.
    times = set()
    masked = list(command + '\n')
    heredoc_pending = False
    quoted_delimiters = []
    for token in bashlex.parser._parser(command).tok:
        if heredoc_pending:
            raw = command[token.lexpos:token.endlexpos]
            if token.ttype != bashlex.tokenizer.tokentype.WORD:
                raise ValueError('HEREDOC_DELIMITER')
            if any(c in raw for c in "'\"\\"):
                delimiter = shlex.split(raw)
                if len(delimiter) != 1 or not re.fullmatch(r'[A-Za-z0-9_]+', delimiter[0]):
                    raise ValueError('HEREDOC_DELIMITER')
                # Work around upstream 0.18 retaining quotes in delimiters.
                # Padding keeps all AST source offsets stable.
                masked[token.lexpos:token.endlexpos] = delimiter[0].ljust(len(raw))
                quoted_delimiters.append((token.lexpos, token.endlexpos))
            heredoc_pending = False
        if token.ttype in (bashlex.tokenizer.tokentype.LESS_LESS, bashlex.tokenizer.tokentype.LESS_LESS_MINUS):
            heredoc_pending = True
        if token.ttype == bashlex.tokenizer.tokentype.TIME:
            times.add(token.lexpos)
            masked[token.lexpos:token.endlexpos] = '_tim'
    trees = bashlex.parse(''.join(masked))
    edits = []

    def literal(node):
        return node.word if not getattr(node, 'parts', []) else None

    def inspect(node):
        words = [p for p in node.parts if p.kind == 'word']
        i = 0
        while i < len(words):
            word = words[i]
            value = literal(word)
            if value is None:
                # No guessed variable dataflow: it may have been reassigned in
                # a branch, function or substitution. Ask for the fixed entry.
                raise ValueError('DYNAMIC_COMMAND')
            name = value
            if name in aliases:
                edits.append((*word.pos, shlex.quote(wrapper)))
                return
            if word.pos[0] in times:
                name = 'time'
            if name in ('/usr/bin/env', '/bin/env', 'env'):
                i += 1
                while i < len(words):
                    v = literal(words[i])
                    if v is None:
                        raise ValueError('DYNAMIC_ENV')
                    if v == '--':
                        i += 1
                        break
                    if v in ('-u', '--unset'):
                        i += 2
                    elif v in ('-i', '--ignore-environment', '-') or v.startswith('--unset=') or ('=' in v and not v.startswith('-')):
                        i += 1
                    elif v.startswith('-'):
                        raise ValueError('ENV_OPTION')
                    else:
                        break
                continue
            if name in ('time', '/usr/bin/time', 'nohup', '/usr/bin/nohup', 'command', 'exec'):
                i += 1
                while i < len(words) and (literal(words[i]) or '').startswith('-'):
                    v = literal(words[i])
                    if name == 'command' and v in ('-v', '-V'):
                        return  # querying a path is not executing it
                    if v == '--':
                        i += 1
                        break
                    if name == 'exec' and v == '-a':
                        i += 2
                    elif (name in ('time', '/usr/bin/time') and v in ('-p', '-l')) or (name == 'command' and v == '-p') or (name == 'exec' and v in ('-c', '-l')):
                        i += 1
                    else:
                        raise ValueError('PREFIX_OPTION')
                continue
            if name in ('eval', 'source', '.', 'bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh') and any(a in command[node.pos[0]:node.pos[1]] for a in aliases):
                raise ValueError('INDIRECT_COMMAND')
            return  # ordinary arguments, prompt text and data stay verbatim

    def visit(node):
        if not isinstance(node, bashlex.ast.node):
            return
        if node.kind == 'command':
            inspect(node)
        if node.kind == 'redirect' and getattr(node, 'heredoc', None):
            quoted = any(a <= node.output.pos[0] < b for a, b in quoted_delimiters)
            body = command[node.heredoc.pos[0]:node.heredoc.pos[1]]
            if not quoted and any(a in body for a in aliases):
                raise ValueError('HEREDOC_EXPANSION')
        for value in vars(node).values():
            if isinstance(value, list):
                for child in value:
                    visit(child)
            elif isinstance(value, bashlex.ast.node):
                visit(value)

    for tree in trees:
        visit(tree)
    for start, end, text in sorted(set(edits), reverse=True):
        command = command[:start] + text + command[end:]
    return command


if __name__ == '__main__':
    try:
        data = json.loads(sys.stdin.read(1048577))
        result = rewrite(data['command'], data['aliases'], data['wrapper'])
        print(json.dumps({'command': result}, ensure_ascii=False))
    except Exception:
        # Never echo shell input, parser exception messages or credentials.
        print(json.dumps({'error': 'USE_EXPLICIT_CODEX_WRAPPER'}))
        sys.exit(2)
