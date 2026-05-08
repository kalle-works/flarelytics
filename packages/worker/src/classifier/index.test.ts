import { describe, it, expect } from 'vitest';
import { classifyUserAgent } from './index';

describe('classifyUserAgent — humans', () => {
  it('classifies Chrome on Mac as human', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'human', ai_actor: '' });
  });

  it('classifies Safari iPhone as human', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'human', ai_actor: '' });
  });
});

describe('classifyUserAgent — empty / missing', () => {
  it('classifies empty string as unknown-bot', () => {
    expect(classifyUserAgent('')).toEqual({ bot_class: 'unknown-bot', ai_actor: '' });
  });

  it('classifies undefined cast to string as unknown-bot', () => {
    const ua = undefined as unknown as string;
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'unknown-bot', ai_actor: '' });
  });
});

describe('classifyUserAgent — AI crawlers', () => {
  it('detects ChatGPT-User', () => {
    const ua = 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/gptbot)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'chatgpt' });
  });

  it('detects GPTBot', () => {
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'gptbot' });
  });

  it('detects ClaudeBot', () => {
    const ua = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'claude' });
  });

  it('detects PerplexityBot', () => {
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'perplexity' });
  });

  it('detects Google-Extended', () => {
    const ua = 'Mozilla/5.0 (compatible; Google-Extended)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'gemini' });
  });

  it('detects OAI-SearchBot as chatgpt', () => {
    const ua = 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'chatgpt' });
  });

  it('detects Applebot-Extended as apple-intelligence', () => {
    const ua = 'Mozilla/5.0 (compatible; Applebot-Extended/1.0)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'apple-intelligence' });
  });
});

describe('classifyUserAgent — search bots', () => {
  it('detects Googlebot as search-bot', () => {
    const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'search-bot', ai_actor: '' });
  });

  it('detects bingbot as search-bot', () => {
    const ua = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'search-bot', ai_actor: '' });
  });

  it('detects YandexBot as search-bot', () => {
    const ua = 'Mozilla/5.0 (compatible; YandexBot/3.0)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'search-bot', ai_actor: '' });
  });
});

describe('classifyUserAgent — generic bots', () => {
  it('detects facebookexternalhit as unknown-bot', () => {
    const ua = 'facebookexternalhit/1.1';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'unknown-bot', ai_actor: '' });
  });

  it('detects Lighthouse as unknown-bot', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Lighthouse';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'unknown-bot', ai_actor: '' });
  });

  it('detects unknown MysteryBot as unknown-bot', () => {
    const ua = 'MysteryBot/1.0';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'unknown-bot', ai_actor: '' });
  });
});

describe('classifyUserAgent — priority', () => {
  it('promotes Google-Extended over Googlebot when both present', () => {
    const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; Google-Extended)';
    expect(classifyUserAgent(ua)).toEqual({ bot_class: 'ai-crawler', ai_actor: 'gemini' });
  });
});

describe('classifyUserAgent — caps', () => {
  it('keeps the longest known ai_actor under 32 UTF-8 bytes', () => {
    const ua = 'Mozilla/5.0 (compatible; Applebot-Extended/1.0)';
    const result = classifyUserAgent(ua);
    const bytes = new TextEncoder().encode(result.ai_actor).length;
    expect(bytes).toBeLessThanOrEqual(32);
    expect(result.ai_actor).toBe('apple-intelligence');
  });
});
