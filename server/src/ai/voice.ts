import type { Voice } from '../domain/types.ts';

/**
 * Last-line enforcement of whose document this is.
 *
 * The prompts carry voice guidance and an explicit prohibition on third-party
 * labels, and between them they take "the author" from pervasive to rare. Rare
 * is not good enough here: the whole claim of the product is that this is the
 * person's own account of their own work, and one sentence calling them "the
 * author" undoes that on the page where a reader happens to land.
 *
 * So the phrasing is also corrected after generation. This is a narrow
 * substitution over a closed set of labels, not a rewriter — it fixes the
 * grammatical role the label appears in and leaves everything else alone.
 *
 * It deliberately does not touch "the author of …", which is someone else: the
 * author of an RFC, of a paper, of a tool's documentation. A references section
 * is allowed to talk about other people.
 */

const LABELS = '(?:author|user|operator|engineer|technician|administrator)';

interface Pronouns {
  subject: string;
  object: string;
  possessive: string;
}

const PRONOUNS: Record<string, Pronouns> = {
  'first-person': { subject: 'I', object: 'me', possessive: 'my' },
  'first-person-plural': { subject: 'we', object: 'us', possessive: 'our' },
};

export function enforceVoice(text: string, voice: Voice | string): string {
  if (!text) return text;

  // An impersonal document has no "I" to substitute, so the attribution is
  // dropped instead: "installed by the author" becomes "installed", which is
  // exactly the register that voice asks for.
  if (voice === 'impersonal') {
    return text
      .replace(new RegExp(`\\s*\\bby the ${LABELS}\\b(?! of\\b)`, 'gi'), '')
      .replace(new RegExp(`\\bthe ${LABELS}'s\\b(?! of\\b)`, 'gi'), 'the')
      .replace(new RegExp(`,?\\s*\\bas (?:stated|described|noted|reported) by the ${LABELS}\\b`, 'gi'), '');
  }

  const pronouns = PRONOUNS[voice] ?? PRONOUNS['first-person']!;

  return (
    text
      // Possessive first: "the author's notes" -> "my notes".
      .replace(new RegExp(`\\bthe ${LABELS}'s\\b(?! of\\b)`, 'gi'), pronouns.possessive)
      // Object position, which is where the leak almost always happens:
      // "described by the author" -> "described by me".
      .replace(
        new RegExp(`\\b(by|to|for|from|with|of)\\s+the ${LABELS}\\b(?! of\\b)`, 'gi'),
        (_match, preposition: string) => `${preposition} ${pronouns.object}`,
      )
      // Anything left is subject position: "the author installed" -> "I installed".
      .replace(new RegExp(`\\bThe ${LABELS}\\b(?! of\\b)`, 'g'), capitalise(pronouns.subject))
      .replace(new RegExp(`\\bthe ${LABELS}\\b(?! of\\b)`, 'g'), pronouns.subject)
  );
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
