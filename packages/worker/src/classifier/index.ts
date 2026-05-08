export type BotClass = 'human' | 'search-bot' | 'ai-crawler' | 'unknown-bot';

export interface ClassifyResult {
  bot_class: BotClass;
  ai_actor: string;
}

// Priority: AI-crawler patterns are checked before search-bot patterns so a
// UA carrying both `Google-Extended` and `Googlebot` resolves to the AI signal.
const AI_PATTERNS: Array<{ needle: string; actor: string }> = [
  { needle: 'chatgpt-user', actor: 'chatgpt' },
  { needle: 'oai-searchbot', actor: 'chatgpt' },
  { needle: 'gptbot', actor: 'gptbot' },
  { needle: 'claudebot', actor: 'claude' },
  { needle: 'claude-web', actor: 'claude' },
  { needle: 'anthropic-ai', actor: 'claude' },
  { needle: 'perplexitybot', actor: 'perplexity' },
  { needle: 'perplexity-user', actor: 'perplexity' },
  { needle: 'google-extended', actor: 'gemini' },
  { needle: 'bytespider', actor: 'bytespider' },
  { needle: 'ccbot', actor: 'commoncrawl' },
  { needle: 'applebot-extended', actor: 'apple-intelligence' },
  { needle: 'meta-externalagent', actor: 'meta-ai' },
  { needle: 'facebookbot', actor: 'meta-ai' },
  { needle: 'diffbot', actor: 'diffbot' },
  { needle: 'cohere-ai', actor: 'cohere' },
  { needle: 'youbot', actor: 'you' },
];

const SEARCH_BOT_PATTERNS = [
  'googlebot',
  'bingbot',
  'duckduckbot',
  'yandexbot',
  'baiduspider',
  'slurp',
];

const GENERIC_BOT_PATTERNS = [
  'bot', 'crawl', 'spider', 'lighthouse', 'pagespeed', 'gtmetrix',
  'pingdom', 'uptimerobot', 'headlesschrome', 'phantomjs', 'semrush',
  'ahrefs', 'moz.com', 'dotbot', 'facebookexternalhit', 'twitterbot',
  'linkedinbot', 'whatsapp', 'telegrambot',
];

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
  return new TextDecoder().decode(bytes.slice(0, end));
}

export function classifyUserAgent(ua: string): ClassifyResult {
  if (!ua) return { bot_class: 'unknown-bot', ai_actor: '' };

  const lower = ua.toLowerCase();

  for (const { needle, actor } of AI_PATTERNS) {
    if (lower.includes(needle)) {
      return { bot_class: 'ai-crawler', ai_actor: truncateUtf8(actor, 32) };
    }
  }

  for (const needle of SEARCH_BOT_PATTERNS) {
    if (lower.includes(needle)) {
      return { bot_class: 'search-bot', ai_actor: '' };
    }
  }

  for (const needle of GENERIC_BOT_PATTERNS) {
    if (lower.includes(needle)) {
      return { bot_class: 'unknown-bot', ai_actor: '' };
    }
  }

  return { bot_class: 'human', ai_actor: '' };
}
