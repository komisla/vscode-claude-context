import test from 'node:test';
import assert from 'node:assert/strict';
import { isAssistantTurn, parseContextUpdateFromLine } from '../dataSource/jsonlTail';

test('assistant turn discriminator uses message role and usage', () => {
  const line = {
    type: 'message',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        output_tokens: 5
      }
    }
  };

  assert.equal(isAssistantTurn(line), true);
  assert.equal(parseContextUpdateFromLine(JSON.stringify(line), 'session.jsonl')?.totalTokens, 121);
});

test('assistant discriminator filters sidechain turns', () => {
  const line = {
    type: 'message',
    isSidechain: true,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 1
      }
    }
  };

  assert.equal(isAssistantTurn(line), false);
  assert.equal(parseContextUpdateFromLine(JSON.stringify(line), 'session.jsonl'), undefined);
});

test('parser ignores iteration usage and uses only outer usage', () => {
  const line = {
    type: 'message',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-20250514',
      usage: {
        input_tokens: 1,
        output_tokens: 1
      },
      iterations: [
        {
          usage: {
            input_tokens: 100_000,
            output_tokens: 100_000
          }
        }
      ]
    }
  };

  assert.equal(parseContextUpdateFromLine(JSON.stringify(line), 'session.jsonl')?.totalTokens, 1);
});

test('parser normalizes missing and invalid models consistently', () => {
  const baseLine = {
    type: 'message',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 1
      }
    }
  };

  assert.equal(parseContextUpdateFromLine(JSON.stringify(baseLine), 'session.jsonl')?.model, 'unknown/absent');
  assert.equal(
    parseContextUpdateFromLine(
      JSON.stringify({
        ...baseLine,
        message: {
          ...baseLine.message,
          model: 123
        }
      }),
      'session.jsonl'
    )?.model,
    'unknown/invalid'
  );
});

test('parser warns once per session when usage has no numeric token fields', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  const line = {
    type: 'message',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      usage: {
        renamed_input_tokens: 1,
        input_tokens: Number.NaN
      }
    }
  };

  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    assert.equal(parseContextUpdateFromLine(JSON.stringify(line), 'invalid-usage.jsonl'), undefined);
    assert.equal(parseContextUpdateFromLine(JSON.stringify(line), 'invalid-usage.jsonl'), undefined);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Assistant usage has no numeric token fields/);
    assert.match(warnings[0], /invalid-usage\.jsonl/);
  } finally {
    console.warn = originalWarn;
  }
});

test('parser skips malformed JSONL lines', () => {
  assert.equal(parseContextUpdateFromLine('{', 'session.jsonl'), undefined);
});
