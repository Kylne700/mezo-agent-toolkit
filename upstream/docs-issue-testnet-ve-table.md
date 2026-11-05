Title: Testnet governance table in mezo-pools.md lists a veBTC deployment whose epoch stopped on 2025-11-13

Draft for the issue tracker of `mezo-org/documentation`. Not posted. The notes for the poster are at the end.

**What this proves: the mechanics, on testnet. No real users or mainnet collateral claimed.**

## What is wrong

The table "Testnet — Governance Contracts" in [`src/content/docs/docs/developers/features/mezo-pools.md`](https://github.com/mezo-org/documentation/blob/87be52da441714e66384555aeba2d4e31122f6fc/src/content/docs/docs/developers/features/mezo-pools.md#L148-L156) (lines 148 to 156 at commit 87be52d) lists five contracts. They are an earlier testnet deployment of the vote-escrow system. Its weekly epoch has not advanced since 2025-11-13. A second deployment, with other addresses, advances every week. A GitHub code search in this repository (2026-11-05) finds each of the five listed addresses in this one file only, and finds none of the second deployment's addresses.

A builder who copies the listed addresses works against a deployment whose epoch no longer advances. Our own first version of a testnet toolkit used the earlier addresses too.

## What the chain says

All values are plain `eth_call` reads of Mezo testnet (chain 31611, `https://rpc.test.mezo.org`) at block 16578888, 2026-11-05T01:03:52Z.

The epoch. `activePeriod()` is the start of the epoch that the contract last rolled.

| Deployment | `VeBTCRewardsDistributor.depositor()` | `activePeriod()` on that address |
|---|---|---|
| In the docs now | `0x63aD4D014246eaD52408dF3BC8F046107cbf6065` | 1762992000 = 2025-11-13T00:00:00Z |
| Second deployment | `0x814b08D5293689F5F57f8B31E40A7903C0A4E191` | 1793836800 = 2026-11-05T00:00:00Z |

The difference is 51 weeks. Our toolkit's `ve_status` answer says the same, in [`evidence/w2/claim1-before.txt` line 73](https://github.com/Kylne700/mezo-agent-toolkit/blob/5fca2ade0e8ffe19bd85e912cd68826a49edf551/evidence/w2/claim1-before.txt#L73): "LIVE distributes (rolled 2026-11-05T00:00:00.000Z); LEGACY is stalled since 2025-11-13T00:00:00.000Z (51 epochs behind)". (The toolkit calls the second deployment LIVE and the one in the docs LEGACY.)

The second deployment pays. Two transactions of ours from 2026-11-05, both on testnet and sent to the second deployment's contracts:

- [`0xebd0e10d3206301284ecf7340df28184a8b2b64c62f1dd0b85fa6b21568fa8b2`](https://explorer.test.mezo.org/tx/0xebd0e10d3206301284ecf7340df28184a8b2b64c62f1dd0b85fa6b21568fa8b2): `claim` on `0x9050218f89F0b5b17df4a30Ba4Fc97C72E307442`, a rebase of 0.000000071972908599 BTC added to a lock.
- [`0x904762d69d7b4d2ea00d65d98e7c1c16145f8be16e68167142875bb2316dc32e`](https://explorer.test.mezo.org/tx/0x904762d69d7b4d2ea00d65d98e7c1c16145f8be16e68167142875bb2316dc32e): a fee claim through `0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D`, 13.339052519580378833 MUSD of the fees of pool 0.

## The rows, one by one

| Docs row | In the docs now | Second deployment | How the two are tied to the row |
|---|---|---|---|
| VeBTC | `0xB63fcCd03521Cf21907627bd7fA465C129479231` | `0x38E35d92E6Bfc6787272A62345856B13eA12130a` | `VeBTCVoter.ve()` and `VeBTCRewardsDistributor.ve()` return it, in each deployment |
| VeBTCVoter | `0x72F8dd7F44fFa19E45955aa20A5486E8EB255738` | `0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D` | `VeBTC.voter()` returns it, in each deployment |
| VeBTCRewardsDistributor | `0x10B0E7b3411F4A38ca2F6BB697aA28D607924729` | `0x9050218f89F0b5b17df4a30Ba4Fc97C72E307442` | its `ve()` returns the VeBTC of the same deployment |
| VeBTCEpochGovernor | `0x12fda93041aD8aB6d133aE4d038b5159033d937a` | not found | the listed address is `VeBTCVoter.epochGovernor()` of the deployment in the docs; the call reverts on the second deployment's voter |
| ChainFeeSplitter | `0x63aD4D014246eaD52408dF3BC8F046107cbf6065` | unclear | the listed address is both `VeBTCVoter.splitter()` and `VeBTCRewardsDistributor.depositor()` of the deployment in the docs. On the second deployment these two calls return different addresses, `0x47FbB2e6d3f6EF14AF3553d139e8af6cc92ed51F` and `0x814b08D5293689F5F57f8B31E40A7903C0A4E191`; both report `activePeriod()` 1793836800. We do not know which one the row should name. |

Both deployments return the same address, `0x6e80164ea60673D64d5d6228beb684a1274Bb017`, from `VeBTCVoter.governor()`, `VeBTCVoter.emergencyCouncil()` and `VeBTC.team()`. We do not know whose address that is.

## What we ask

1. Replace the three rows VeBTC, VeBTCVoter and VeBTCRewardsDistributor with the second deployment's addresses, and keep the five earlier rows under a heading that says the epoch stopped, so that nobody reads them as current. We have this change ready as a pull request (10 lines added, none removed) and will open it if that suits you.
2. Tell us the second deployment's VeBTCEpochGovernor and ChainFeeSplitter, if they exist, or that they do not.

## Notes for the poster (delete before posting)

- The bold line under the draft note repeats our repo's testnet-only rule. Keep it or delete it.
- The reads are from block 16578888. The earlier deployment's values do not change while it stays stalled. The second deployment's `activePeriod()` moves every Thursday 00:00 UTC; re-read before posting if the issue is posted after 2026-11-12.
- `docs-pr-testnet-ve-table.patch` is a unified diff of the real file at the commit above and passes `git apply --check` on it. Its first line is our testnet-only sentence; `git apply` and `patch -p1` skip it (both tried on the file at that commit). The docs repository is GPL-3.0 and the patch holds a few lines of that file as context. Send it to that repository only.
- Suggested branch `docs/mezo-pools-testnet-governance`, suggested PR title `docs(mezo-pools): list the live testnet governance contracts`. The repository's README asks for Prettier (`npm run lint-fix`). The patch follows the table style the file has today and was not run through Prettier (not checked).
