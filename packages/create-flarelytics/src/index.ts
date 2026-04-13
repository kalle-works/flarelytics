import { main } from './prompts.js';

main(process.argv.slice(2)).catch((err) => {
  console.error('Unexpected error:', err.message || err);
  process.exit(1);
});
