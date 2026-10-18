# Narration of the pitch video (Mezo Buildathon, Wave 1). One line is one sentence for the voice; the printed form is what the captions show.
# A numbered heading opens a story step, a three-hash heading a beat (one scene of the video); a name in double braces is filled from the take. Spoken respellings: config.mjs.

## 1. Problem
### problem
Agents can read Mezo, but they cannot pay for the data.
None of the ten entries listed on October 18 mentions MCP tools or an x402 buyer.

## 2. A paid call
### paid
This is the Mezo Agent Toolkit.
A request without payment gets a 402 and a price: 0.001 MUSD.
The agent signs a Permit2 permit; the facilitator settles it on Mezo, and the data comes back.
### explorer
Anyone can check it: here is the transfer on the explorer, 0.001 MUSD from the agent to the payee.
The agent paid no gas.

## 3. MCP tools and the spend cap
### mcp-tools
The same buyer is an MCP server with five tools.
Four are free reads through the on-chain lens: trove health, redemption risk, pool quotes and vote-escrow locks.
A scripted client calls them here, as an agent host would.
### mcp-cap
The fifth, pay and fetch, buys data under limits that the operator sets, not the agent.
Here the limit is 0.001 MUSD for the whole session.
The first call settles. The second is refused before anything is signed.
### nodouble
If a payment is not confirmed, the buyer will not pay that URL again until the chain shows the first one can no longer land.
These are offline tests, with a stub facilitator.

## 4. The lens and the console
### lens
One lens call walks {{steps}} positions of the redemption queue in a single read.
Redemptions take the lowest collateral ratios first, so queue position is risk.
### console
The console lists recent paid calls, read from the chain, each with its transaction.

## 5. End
### end
That was the Mezo Agent Toolkit, open source on GitHub.
Live demo: link in the README. Testnet only.
