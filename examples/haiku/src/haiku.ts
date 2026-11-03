const FIVES = [
  "a coin for a verse",
  "the server says pay",
  "four-oh-two returns",
  "morning fog lifting",
  "one tenth of a cent",
  "the block is sealed now",
  "quiet river stones",
  "an agent wanders",
];

const SEVENS = [
  "signed promise crosses the wire",
  "no account, no key, just pay",
  "cherry petals on the chain",
  "the facilitator nods",
  "coins drift down like autumn leaves",
  "the pale moon settles on Base",
  "a heron waits by the pond",
  "frost glitters on the ledger",
];

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

export function randomHaiku(): string[] {
  const first = pick(FIVES);
  return [first, pick(SEVENS), pick(FIVES.filter((line) => line !== first))];
}
