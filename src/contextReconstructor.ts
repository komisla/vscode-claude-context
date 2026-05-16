import { encode } from 'gpt-tokenizer';
import type { ContextUpdate } from './dataSource';

export interface ContextCategory {
  readonly label: string;
  readonly tokens: number;
  readonly estimated: boolean;
}

export interface ContextBreakdown {
  readonly source: ContextUpdate;
  readonly categories: readonly ContextCategory[];
}

export function countTokens(text: string): number {
  return encode(text).length;
}

export async function reconstructContextBreakdown(source: ContextUpdate): Promise<ContextBreakdown> {
  return {
    source,
    categories: []
  };
}
