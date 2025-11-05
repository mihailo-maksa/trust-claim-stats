import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

/**
 * Minimal, single-file dashboard.
 * - Reads:
 *    • Base:  TRUST.balanceOf(MetaERC20Hub)
 *    • L3:    WTRUST.balanceOf(TrustBonding)           -> total bonded
 *    • L3:    WTRUST.balanceOf(Vault)                  -> unclaimed airdrop remainder
 * - Computes:
 *    • Total claimed                                   = ALLOCATED - vaultBalance
 *    • Bridged to Base (from airdrop)                  = ALLOCATED - hubBalanceOnBase
 *    • Left to be claimed (first 3 tranches)           = CLAIMABLE_3 - totalClaimed
 *    • Left to be claimed (total)                      = ALLOCATED - totalClaimed
 *    • Ratios & extrapolated additional selling pressure (first 3 tranches):
 *          rBridge = bridged/claimed, rBond = bonded/claimed
 *          extraSell = left3 * max(0, rBridge - rBond)
 *      plus 1.5x and 2x “conservative” multipliers.
 *
 * Assumptions:
 *  - TRUST and WTRUST use 18 decimals.
 *  - All reads are ERC-20 balanceOf(address).
 *  - CORS must be allowed by RPCs (Base + Intuition).
 */

// ----------------------------- Constants -----------------------------

// RPCs
const RPC_BASE = "https://mainnet.base.org";
const RPC_INTUITION = "https://rpc.intuition.systems";

// Addresses (checksummed as provided)
const TRUST_BASE = "0x6cd905dF2Ed214b22e0d48FF17CD4200C1C6d8A3";
const META_ERC20_HUB_BASE = "0xE12aaF1529Ae21899029a9b51cca2F2Bc2cfC421";

const WTRUST_L3 = "0x81cFb09cb44f7184Ad934C09F82000701A4bF672";
const TRUST_BONDING_L3 = "0x635bBD1367B66E7B16a21D6E5A63C812fFC00617";
const AIRDROP_VAULT_L3 = "0x1edeC665ab682A6411ffBAd403FdCb5fE112b867";

// Hard-coded amounts (18-decimals assumed)
const ALLOCATED_AIRDROP = "35921361.0640907"; // TRUST
const CLAIMABLE_FIRST_3 = "18180720.53204535"; // TRUST

// Minimal ABI for ERC-20 balanceOf
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

// Decimals (assumed)
const DECIMALS = 18;

// --------------------------- Helpers ---------------------------------

const toUnits = (x: bigint) => ethers.formatUnits(x, DECIMALS);
const toBig = (x: string | number) => ethers.parseUnits(String(x), DECIMALS);

// safe % formatter
function pct(n: number) {
  if (!isFinite(n)) return "—";
  return (n * 100).toFixed(2) + "%";
}
function num(x: number, d = 2) {
  if (!isFinite(x)) return "—";
  return x.toLocaleString(undefined, { maximumFractionDigits: d });
}
function fmt(x: string, d = 2) {
  const n = Number(x);
  return num(n, d);
}

type LoadState<T> = { loading: boolean; error?: string; data?: T };

async function readBalance(
  rpcUrl: string,
  token: string,
  holder: string
): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  const bal: bigint = await erc20.balanceOf(holder);
  return bal;
}

// ---------------------------- Component ------------------------------

export default function App() {
  const [hubBal, setHubBal] = useState<LoadState<bigint>>({ loading: true });
  const [bondedBal, setBondedBal] = useState<LoadState<bigint>>({
    loading: true,
  });
  const [vaultBal, setVaultBal] = useState<LoadState<bigint>>({
    loading: true,
  });
  const [refreshing, setRefreshing] = useState(false);

  // Fetch all three reads
  const fetchAll = async () => {
    setRefreshing(true);
    setHubBal({ loading: true });
    setBondedBal({ loading: true });
    setVaultBal({ loading: true });
    try {
      const [hub, bonded, vault] = await Promise.all([
        readBalance(RPC_BASE, TRUST_BASE, META_ERC20_HUB_BASE),
        readBalance(RPC_INTUITION, WTRUST_L3, TRUST_BONDING_L3),
        readBalance(RPC_INTUITION, WTRUST_L3, AIRDROP_VAULT_L3),
      ]);
      setHubBal({ loading: false, data: hub });
      setBondedBal({ loading: false, data: bonded });
      setVaultBal({ loading: false, data: vault });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // Set any missing ones to error, but try not to clobber successful reads
      setHubBal((s) => (s.loading ? { loading: false, error: msg } : s));
      setBondedBal((s) => (s.loading ? { loading: false, error: msg } : s));
      setVaultBal((s) => (s.loading ? { loading: false, error: msg } : s));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived amounts (BigInt)
  const derived = useMemo(() => {
    const allocated = toBig(ALLOCATED_AIRDROP);
    const claimable3 = toBig(CLAIMABLE_FIRST_3);

    const hub = hubBal.data ?? 0n; // TRUST on MetaERC20Hub (Base)
    const bonded = bondedBal.data ?? 0n; // WTRUST in TrustBonding (L3)
    const vault = vaultBal.data ?? 0n; // WTRUST in Vault (L3)

    // Per spec:
    //  totalClaimed = ALLOCATED - vaultBalance
    const totalClaimed = allocated > vault ? allocated - vault : 0n;

    //  bridgedToBase (from airdrop) = ALLOCATED - hubBalance
    const bridgedToBase = allocated > hub ? allocated - hub : 0n;

    //  left to be claimed (first 3 tranches)
    const left3 = claimable3 > totalClaimed ? claimable3 - totalClaimed : 0n;

    //  left to be claimed (total)
    const leftTotal = allocated > totalClaimed ? allocated - totalClaimed : 0n;

    // Ratios based on CLAIMED (avoid div by zero)
    const claimedF = Number(toUnits(totalClaimed));
    const bondedF = Number(toUnits(bonded));
    const bridgedF = Number(toUnits(bridgedToBase));

    const ratioBondedOfClaimed = claimedF > 0 ? bondedF / claimedF : NaN;
    const ratioBridgedOfClaimed = claimedF > 0 ? bridgedF / claimedF : NaN;
    const ratioBondedOfBridged = bridgedF > 0 ? bondedF / bridgedF : NaN;

    // Extrapolated additional selling pressure for the remaining of the first 3 tranches
    // Heuristic: new selling ≈ left3 * (rBridge - rBond), never below 0
    const left3F = Number(toUnits(left3));
    const deltaRatio = Math.max(
      0,
      (ratioBridgedOfClaimed || 0) - (ratioBondedOfClaimed || 0)
    );
    const extraSell = left3F * deltaRatio;
    const extraSell15 = extraSell * 1.5;
    const extraSell2 = extraSell * 2;

    return {
      allocated,
      claimable3,
      hub,
      bonded,
      vault,
      totalClaimed,
      bridgedToBase,
      left3,
      leftTotal,
      // floats for display
      claimedF,
      bondedF,
      bridgedF,
      left3F,
      ratioBondedOfClaimed,
      ratioBridgedOfClaimed,
      ratioBondedOfBridged,
      extraSell,
      extraSell15,
      extraSell2,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubBal.data, bondedBal.data, vaultBal.data]);

  const anyLoading = hubBal.loading || bondedBal.loading || vaultBal.loading;

  // ---------------------------- UI ----------------------------

  return (
    <div className="wrapper">
      <style>{css}</style>

      <header className="bar">
        <div>
          <h1>TRUST Airdrop Claim Stats</h1>
          <p className="muted">
            Live reads from Base mainnet & Intuition mainnet. All values assume
            18 decimals.
          </p>
        </div>
        <div className="actions">
          <button onClick={fetchAll} disabled={anyLoading || refreshing}>
            {anyLoading || refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="grid">
        <Card
          title="Total Claimable (all 4 tranches)"
          primary={fmt(ALLOCATED_AIRDROP)}
          suffix="TRUST"
          subtitle="Total allocation for the airdrop"
        />
        <Card
          title="Claimable Today (first 3 tranches)"
          primary={fmt(CLAIMABLE_FIRST_3)}
          suffix="TRUST"
          subtitle="Hard-coded"
        />
        <Card
          title="MetaERC20Hub Balance (Base)"
          primary={hubBal.error ? "Error" : fmt(toUnits(derived.hub))}
          suffix="TRUST"
          subtitle="TRUST.balanceOf(MetaERC20Hub)"
          state={hubBal}
        />
        <Card
          title="Bridged to Base (from airdrop)"
          primary={fmt(toUnits(derived.bridgedToBase))}
          suffix="TRUST"
          subtitle="Allocated - Hub balance"
          highlight
        />
      </section>

      <section className="grid">
        <Card
          title="WTRUST Bonded on L3"
          primary={bondedBal.error ? "Error" : fmt(toUnits(derived.bonded))}
          suffix="TRUST"
          subtitle="WTRUST.balanceOf(TrustBonding)"
          state={bondedBal}
        />
        <Card
          title="WTRUST in Airdrop Vault (L3)"
          primary={vaultBal.error ? "Error" : fmt(toUnits(derived.vault))}
          suffix="TRUST"
          subtitle="WTRUST.balanceOf(Vault)"
          state={vaultBal}
        />
        <Card
          title="Total Claimed"
          primary={fmt(toUnits(derived.totalClaimed))}
          suffix="TRUST"
          subtitle="Allocated - Vault balance"
          highlight
        />
        <Card
          title="Left to be Claimed (first 3 tranches)"
          primary={fmt(toUnits(derived.left3))}
          suffix="TRUST"
          subtitle="Claimable3 - Total claimed"
        />
        <Card
          title="Left to be Claimed (total)"
          primary={fmt(toUnits(derived.leftTotal))}
          suffix="TRUST"
          subtitle="Allocated - Total claimed"
        />
      </section>

      <section className="grid ratios">
        <Card
          title="Bonded / Claimed"
          primary={pct(derived.ratioBondedOfClaimed)}
          subtitle={`= ${num(derived.bondedF)} / ${num(
            derived.claimedF
          )} TRUST`}
        />
        <Card
          title="Claimed / Bonded (x)"
          primary={
            derived.bondedF > 0
              ? num(derived.claimedF / derived.bondedF, 2) + "×"
              : "—"
          }
          subtitle="Inverse of Bonded/Claimed"
        />
        <Card
          title="Bonded / Bridged"
          primary={pct(derived.ratioBondedOfBridged)}
          subtitle={`= ${num(derived.bondedF)} / ${num(
            derived.bridgedF
          )} TRUST`}
        />
        <Card
          title="Bridged / Claimed"
          primary={pct(derived.ratioBridgedOfClaimed)}
          subtitle={`= ${num(derived.bridgedF)} / ${num(
            derived.claimedF
          )} TRUST`}
        />
      </section>

      <section className="panel">
        <h2>Extrapolated Additional Selling Pressure (first 3 tranches)</h2>
        <p className="muted">
          Formula:{" "}
          <code>
            leftToBeClaimedFromTheFirst3Tranches × (bridged/claimed −
            bonded/claimed)
          </code>
        </p>
        <div className="pill-row">
          <Pill label="Base" value={`${num(derived.extraSell, 2)} TRUST`} />
          <Pill label="×1.5" value={`${num(derived.extraSell15, 2)} TRUST`} />
          <Pill label="×2" value={`${num(derived.extraSell2, 2)} TRUST`} />
        </div>
      </section>

      <footer className="foot">
        <div className="muted tiny">
          <strong>RPCs</strong>: Base ({RPC_BASE}) · Intuition ({RPC_INTUITION}
          )&nbsp;|&nbsp;
          <strong>TRUST (Base)</strong>:{" "}
          <a href="https://basescan.org/token/0x6cd905dF2Ed214b22e0d48FF17CD4200C1C6d8A3">
            {short(TRUST_BASE)}
          </a>{" "}
          · <strong>MetaERC20Hub</strong>:{" "}
          <a href="https://basescan.org/address/0xE12aaF1529Ae21899029a9b51cca2F2Bc2cfC421">
            {short(META_ERC20_HUB_BASE)}
          </a>{" "}
          · <strong>WTRUST (L3)</strong>:{" "}
          <a href="https://explorer.intuition.systems/token/0x81cFb09cb44f7184Ad934C09F82000701A4bF672">
            {short(WTRUST_L3)}
          </a>
        </div>
      </footer>
    </div>
  );
}

// ------------------------- Small UI bits -----------------------------

function Card(props: {
  title: string;
  primary: string;
  subtitle?: string;
  suffix?: string;
  highlight?: boolean;
  state?: LoadState<any>;
}) {
  const { title, primary, subtitle, suffix, highlight, state } = props;
  const loading = state?.loading;
  const error = state?.error;

  return (
    <div className={`card ${highlight ? "highlight" : ""}`}>
      <div className="card-title">{title}</div>
      <div className="card-value">
        {loading ? <span className="spinner" /> : primary}
        {suffix ? <span className="suffix">&nbsp;{suffix}</span> : null}
      </div>
      {error ? <div className="error">Error: {error}</div> : null}
      {subtitle ? (
        <div className="card-sub">{subtitle}</div>
      ) : (
        <div style={{ height: 4 }} />
      )}
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="pill">
      <div className="pill-label">{label}</div>
      <div className="pill-value">{value}</div>
    </div>
  );
}

function short(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

// ------------------------------ CSS ----------------------------------

const css = `
:root {
  --bg: #0b0c10;
  --card: #121319;
  --text: #e8ecf1;
  --muted: #9aa3ad;
  --accent: #6ee7b7;
  --accent2: #60a5fa;
  --danger: #f87171;
  --border: #1e2130;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  background: radial-gradient(1200px 600px at 70% -10%, #0f1121 0%, #0b0c10 55%);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial;
}

a {
  color: var(--accent2);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.wrapper {
  max-width: 1100px;
  margin: 24px auto 64px;
  padding: 0 16px;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.bar h1 { margin: 0 0 6px 0; font-weight: 700; letter-spacing: .2px; }
.muted { color: var(--muted); }
.tiny { font-size: 12px; }

.actions button {
  background: var(--accent2);
  color: #04121f;
  border: none;
  padding: 10px 14px;
  border-radius: 12px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(96,165,250,.25);
}
.actions button:disabled { opacity: .6; cursor: default; }

.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}
@media (max-width: 980px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .grid { grid-template-columns: 1fr; }
}

.card {
  background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 14px 14px 12px;
  min-height: 96px;
}
.card.highlight { border-color: rgba(110,231,183,.4); box-shadow: inset 0 0 0 1px rgba(110,231,183,.1); }
.card-title { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
.card-value {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: .2px;
  display: flex; align-items: baseline; gap: 6px;
}
.card-sub { margin-top: 6px; color: var(--muted); font-size: 12px; }
.suffix { font-size: 13px; color: var(--muted); font-weight: 600; }

.error { margin-top: 6px; color: var(--danger); font-size: 12px; }

.spinner {
  width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.2); border-top-color: var(--accent2);
  border-radius: 50%; display: inline-block; animation: spin .9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.panel {
  margin-top: 18px;
  background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 16px;
}
.panel h2 { margin: 0 0 6px 0; }
.pill-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.pill {
  background: #0e1726;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 8px 12px;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}
.pill-label { color: var(--muted); font-size: 12px; }
.pill-value { font-weight: 800; }

.foot { margin-top: 18px; }
`;

// ---------------------------------------------------------------------
