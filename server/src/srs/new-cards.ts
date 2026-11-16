/**
 * Which new cards may be introduced today. Shared by /queue and /stats so they always agree.
 *
 * A new production card (uk_en) waits until its recognition sibling (en_uk) was first
 * reviewed on an earlier day, so both sides of a word don't appear back to back.
 *
 * Expects `cards c JOIN words w` in the query. `deck` and `dayStart` are SQL parameter
 * placeholders such as "$1".
 */
export function newCardEligibleSql(deck: string, dayStart: string): string {
  return `NOT w.archived AND w.deck = ${deck} AND c.state = 0 AND (
    c.direction = 'en_uk' OR EXISTS (
      SELECT 1 FROM cards s WHERE s.word_id = c.word_id AND s.direction = 'en_uk'
        AND s.state <> 0 AND s.last_review < ${dayStart}))`;
}
