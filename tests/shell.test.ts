import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { shellQuote } from '../src/shared/shell.js';
import { serviceDefinition } from '../src/service.js';

test('copyable shell arguments preserve substitutions, quotes and unicode literally', () => {
  const input = "/tmp/папка 'quoted' $(printf BAD) `printf BAD` ${HOME}; echo BAD";
  const child = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(input)}`], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, input);
});

test('systemd ExecStart escapes environment substitutions independently from Environment', () => {
  const definition = serviceDefinition('agent', '/tmp/state ${HOME} $USER 100%', 'linux');
  const exec = definition.content.split('\n').find((line) => line.startsWith('ExecStart='))!;
  assert.ok(exec.includes('"/tmp/state $${HOME} $$USER 100%%"'));
  // Unlike ExecStart, a PATH value in Environment= must keep literal single dollars.
  const previous = process.env.PATH;
  process.env.PATH = '/tmp/$USER/bin';
  try {
    assert.ok(
      serviceDefinition('agent', '/tmp/state', 'linux').content.includes(
        'Environment="PATH=/tmp/$USER/bin"',
      ),
    );
  } finally {
    process.env.PATH = previous;
  }
});
