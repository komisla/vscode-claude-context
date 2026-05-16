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
  assert.equal(parseContextUpdateFromLine(JSON.stringify(line), 'session.jsonl')?.totalTokens, 126);
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

  assert.equal(parseContextUpdateFromLine(JSON.stringify(line), 'session.jsonl')?.totalTokens, 2);
});

test('parser skips malformed JSONL lines', () => {
  assert.equal(parseContextUpdateFromLine('{', 'session.jsonl'), undefined);
});
