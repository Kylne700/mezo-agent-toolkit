// The Wave 2 narration: sentences grouped in beats, and which screen is up while each sentence is spoken.
// Numbers come from facts.json (repo files and free local runs). Words are plain; the jargon that the cloud speech check misheard in
// pilots (Mezo, MUSD, veBTC, testnet, mainnet, https, read tools, Claude Code) is written in plain words here. The screens carry the names.
export const LEAD = 0.3 // silence before the first word
export const GAP = 0.3 // between sentences of one beat
export const BEAT_GAP = 0.7 // between beats
export const END_TAIL = 3 // the end card stays this long after the last word
export const MIN_S = 90 // the brief: 1:30 to 2:00, never over 2:15
export const MAX_S = 120
export const STORY_BY = 20 // the claim -> repay story must be complete on screen before this second
export const REPAY_BY = 14 // the repay page must be up before this second

const BANNED = /\b(independent|audits?|audited|revolutionary|seamless(ly)?|game-?chang\w*|cutting-edge|unprecedented|best-in-class|world-class|blazing\w*|powerful|amazing|groundbreaking|first-ever|unmatched|perfect(ly)?)\b/i
export const gate = (text, where) => { const m = text.match(BANNED); if (m) throw new Error(`wording gate: "${m[0]}" in ${where}`) }

export function script(f) {
  const c = f.chain
  const beats = [
    { id: 'b1', sentences: [
      ['s01', `In Wave two, an agent claimed its lock rewards, which came to ${c.shortClaimed}.`],
      ['s02', 'Then it sent that same amount back to repay its own loan.'],
      ['s03', `The debt fell from ${c.shortBefore} to ${c.shortAfter}, exactly the amount claimed.`, 0.5],
      ['s04', 'The transactions are real, and these pages are the live explorer.'],
    ] },
    { id: 'b2', sentences: [
      ['s05', 'This is the live tool list from the server.'],
      ['s06', `${f.tools.reads.length} tools are free and only look things up.`, 0.6],
      ['s07', `${f.tools.writes.length} more tools can send transactions, and they exist only when the operator switches them on.`, 0.6],
      ['s08', 'Writes fail while the switch is off.', 1],
    ] },
    { id: 'b3', sentences: [
      ['s10', 'A separate review of the code found one high and two medium problems, and all three are fixed.'],
      ['s11', 'A lock now lets only one process send at a time.'],
      ['s12', 'Payment requests need a secure web address, except to this machine.'],
      ['s13', 'A key file that other accounts can read now triggers a warning.'],
      ['s14', 'Each fix has a test, named on screen.', 1],
    ] },
    { id: 'b4', sentences: [
      ['s15', `The chain shows ${f.payments.count} payments to the demo payee.`],
      ['s16', `All of them came from one sender, our own wallet, so outside senders are ${f.payments.outside}.`, 1.5],
    ] },
    { id: 'b5', sentences: [
      ['s17', 'Not done: nobody outside has paid, and voting is built for one lock type only.'],
      ['s18', 'Two write tools never sent a real transaction, and nothing is on the main network.'],
      ['s19', 'The full list is on screen.', 1.2],
    ] },
    { id: 'b6', sentences: [
      ['s20', 'Everything here ran with test money. It shows the mechanics, and we claim no real users and no real collateral.'],
      ['s21', 'It was built with AI help, and the voice is AI too.'],
    ] },
  ].map((b) => ({ id: b.id, sentences: b.sentences.map(([id, text, pad = 0]) => ({ id, text, pad })) }))
  for (const b of beats) for (const s of b.sentences) gate(s.text, s.id)
  // the screen that is up from the start of the named sentence until the next segment starts
  const segments = [
    { screen: 'claim', from: 's01' }, { screen: 'repay', from: 's02' }, { screen: 'debt', from: 's03' },
    { screen: 'tools', variant: 'reads', from: 's05' }, { screen: 'tools', variant: 'writes', from: 's07' }, { screen: 'refused', from: 's08' },
    { screen: 'fixes', variant: 'none', from: 's10' }, { screen: 'fixes', variant: 'R1', from: 's11' }, { screen: 'fixes', variant: 'R2', from: 's12' },
    { screen: 'fixes', variant: 'R3', from: 's13' }, { screen: 'fixes', variant: 'all', from: 's14' },
    { screen: 'payments', from: 's15' }, { screen: 'notdone', from: 's17' }, { screen: 'end', from: 's20' },
  ]
  return { beats, segments }
}
