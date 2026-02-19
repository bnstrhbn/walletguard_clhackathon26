import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashCanonicalJson } from '../packages/common/src/crypto.js';

type Row = {
  fixture: string;
  score?: number;
  level?: string;
  flags?: string;
  reportHash?: string;
  ok: boolean;
  error?: string;
};

function normalizeAddress(addr: unknown): string {
  if (typeof addr !== 'string') return String(addr);
  return addr.toLowerCase();
}

function normalizeHex(hex: unknown): string {
  if (typeof hex !== 'string') return String(hex);
  return hex.toLowerCase();
}

function normalizeDecodedCallArgs(args: unknown): Record<string, string | number | boolean> | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const obj = args as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = obj[k];
    if (typeof v === 'string') {
      if (/^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = v.toLowerCase();
      else if (/^0x[0-9a-fA-F]*$/.test(v)) out[k] = v.toLowerCase();
      else out[k] = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

function requestForCommitment(request: any): any {
  return {
    chainId: request && request.chainId,
    from: normalizeAddress(request && request.from),
    to: normalizeAddress(request && request.to),
    data: normalizeHex(request && request.data),
    value: request && request.value,
    blockTag: request && request.blockTag,
  };
}

function simulationForCommitment(simulation: any): any {
  const nativeBalanceDeltas = Array.isArray(simulation && simulation.nativeBalanceDeltas)
    ? simulation.nativeBalanceDeltas.map((d: any) => {
      return { address: normalizeAddress(d && d.address), deltaWei: d && d.deltaWei };
    })
    : [];

  const tokenBalanceDeltas = Array.isArray(simulation && simulation.tokenBalanceDeltas)
    ? simulation.tokenBalanceDeltas.map((d: any) => {
      return {
        token: normalizeAddress(d && d.token),
        holder: normalizeAddress(d && d.holder),
        delta: d && d.delta,
      };
    })
    : [];

  const decodedCalls = Array.isArray(simulation && simulation.decodedCalls)
    ? simulation.decodedCalls.map((c: any) => {
      return {
        to: normalizeAddress(c && c.to),
        functionSig: c && c.functionSig ? normalizeHex(c.functionSig) : undefined,
        functionName: c && c.functionName,
        args: normalizeDecodedCallArgs(c && c.args),
      };
    })
    : [];

  const logs = Array.isArray(simulation && simulation.logs)
    ? simulation.logs.map((l: any) => {
      const topics = Array.isArray(l && l.topics) ? l.topics.map((t: any) => normalizeHex(t)) : [];
      return {
        address: normalizeAddress(l && l.address),
        topics,
        data: normalizeHex(l && l.data),
      };
    })
    : undefined;

  return {
    success: simulation && simulation.success === true,
    nativeBalanceDeltas,
    tokenBalanceDeltas,
    decodedCalls,
    logs,
  };
}

function parseSimulationJson(output: string): any {
  const marker = 'Workflow Simulation Result:';
  const idx = output.indexOf(marker);
  if (idx === -1) return undefined;

  const after = output.slice(idx + marker.length);
  const start = after.indexOf('{');
  const end = after.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;

  const jsonText = after.slice(start, end + 1);
  return JSON.parse(jsonText);
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function sortFlagCodes(codes: string[]): string {
  return codes.slice().sort((a, b) => a.localeCompare(b)).join(',');
}

function baselinePathForTarget(repoRoot: string, target: string): string {
  return path.join(repoRoot, 'scripts', `fixtures-baseline.${target}.json`);
}

function readBaseline(filePath: string): Record<string, { score: number; level: string; flags: string }> {
  const text = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as Record<string, { score: number; level: string; flags: string }>;
  return parsed;
}

function writeBaseline(filePath: string, data: Record<string, { score: number; level: string; flags: string }>): void {
  const text = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(filePath, text);
}

function rowToBaseline(r: Row): { score: number; level: string; flags: string } {
  return {
    score: r.score || 0,
    level: r.level || 'low',
    flags: r.flags || '',
  };
}

function main(): void {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  let workflowRel = './cre-workflows/walletguard-analyze';
  let target = 'staging-settings';
  let updateBaseline = false;
  let checkBaseline = false;
  let rpcSmoke = false;

  let sawWorkflow = false;
  let sawTarget = false;
  for (const arg of argv) {
    if (arg === '--rpc-smoke') {
      rpcSmoke = true;
      continue;
    }
    if (arg === '--update-baseline') {
      updateBaseline = true;
      continue;
    }
    if (arg === '--check-baseline') {
      checkBaseline = true;
      continue;
    }
    if (!sawWorkflow) {
      workflowRel = arg;
      sawWorkflow = true;
      continue;
    }
    if (!sawTarget) {
      target = arg;
      sawTarget = true;
      continue;
    }
  }

  if (rpcSmoke && !sawTarget) {
    target = 'staging-settings-rpc';
  }

  const workflowPath = path.resolve(repoRoot, workflowRel);
  const fixturesDir = path.join(workflowPath, 'fixtures');

  const fixtures = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  let selectedFixtures = fixtures;
  if (rpcSmoke) {
    const smokeList = [
      'synth-01-eth-transfer-value-only.json',
      'solodit-01-erc20-approve-limited.json',
      'solodit-03-erc20-transfer.json',
      'synth-03-unknown-selector.json',
    ];
    selectedFixtures = fixtures.filter((f) => smokeList.includes(f));
    if (selectedFixtures.length === 0) {
      selectedFixtures = fixtures.slice(0, Math.min(3, fixtures.length));
    }
    updateBaseline = false;
    checkBaseline = false;
  }

  const rows: Row[] = [];

  for (const fixture of selectedFixtures) {
    const absFixture = path.resolve(fixturesDir, fixture);
    const args = [
      '-T',
      target,
      'workflow',
      'simulate',
      workflowPath,
      '--non-interactive',
      '--trigger-index',
      '0',
      '--http-payload',
      `@${absFixture}`,
    ];

    const res = spawnSync('cre', args, { encoding: 'utf8' });
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;

    if (res.status !== 0) {
      rows.push({ fixture, ok: false, error: combined.trim().slice(0, 300) });
      continue;
    }

    let parsed: any;
    try {
      parsed = parseSimulationJson(combined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ fixture, ok: false, error: `PARSE_FAILED:${msg}` });
      continue;
    }

    const risk = parsed && parsed.risk ? parsed.risk : undefined;
    const flagsArr = risk && Array.isArray(risk.flags) ? risk.flags : [];
    const flagCodesList = flagsArr
      .map((f: any) => (f && typeof f.code === 'string' ? f.code : ''))
      .filter((x: string) => x);
    const flagCodes = sortFlagCodes(flagCodesList);

    const reportHash =
      parsed && parsed.provenance && typeof parsed.provenance.reportHash === 'string'
        ? (parsed.provenance.reportHash as string)
        : '';

    try {
      const reportForHash = {
        request: requestForCommitment(parsed.request),
        simulation: simulationForCommitment(parsed.simulation),
        risk: parsed.risk,
        summary: parsed.summary,
        provenance: {
          engineVersion: parsed.provenance && parsed.provenance.engineVersion,
        },
      };
      const expected = hashCanonicalJson(reportForHash);
      if (expected !== reportHash) {
        rows.push({
          fixture,
          ok: false,
          error: `REPORT_HASH_MISMATCH expected=${expected} got=${reportHash}`,
        });
        continue;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ fixture, ok: false, error: `REPORT_HASH_CHECK_FAILED:${msg}` });
      continue;
    }

    rows.push({
      fixture,
      ok: true,
      score: risk && typeof risk.score === 'number' ? risk.score : undefined,
      level: risk && typeof risk.level === 'string' ? risk.level : undefined,
      flags: flagCodes,
      reportHash,
    });
  }

  const baselinePath = baselinePathForTarget(repoRoot, target);
  const baselineData: Record<string, { score: number; level: string; flags: string }> = {};
  for (const r of rows) {
    if (!r.ok) continue;
    baselineData[r.fixture] = rowToBaseline(r);
  }

  if (updateBaseline) {
    const failures = rows.filter((r) => !r.ok);
    if (failures.length > 0) {
      process.stderr.write('Refusing to update baseline because some fixtures failed:\n');
      for (const f of failures) {
        process.stderr.write(`- ${f.fixture}: ${f.error || 'UNKNOWN_ERROR'}\n`);
      }
      process.exit(1);
      return;
    }
    writeBaseline(baselinePath, baselineData);
    process.stdout.write(`Baseline updated: ${baselinePath}\n`);
  }

  let baselineMismatch = false;
  if (checkBaseline) {
    let expected: Record<string, { score: number; level: string; flags: string }>;
    try {
      expected = readBaseline(baselinePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`Failed to read baseline ${baselinePath}: ${msg}\n`);
      process.exit(2);
      return;
    }

    const fixturesInExpected = new Set(Object.keys(expected));
    for (const r of rows) {
      fixturesInExpected.delete(r.fixture);
      if (!r.ok) {
        baselineMismatch = true;
        process.stderr.write(`Mismatch ${r.fixture}: run failed (${r.error || 'UNKNOWN_ERROR'})\n`);
        continue;
      }
      const exp = expected[r.fixture];
      if (!exp) {
        baselineMismatch = true;
        process.stderr.write(`Mismatch ${r.fixture}: not present in baseline\n`);
        continue;
      }
      const got = rowToBaseline(r);
      if (exp.score !== got.score || exp.level !== got.level || exp.flags !== got.flags) {
        baselineMismatch = true;
        process.stderr.write(
          `Mismatch ${r.fixture}: expected score=${exp.score} level=${exp.level} flags=${exp.flags} got score=${got.score} level=${got.level} flags=${got.flags}\n`,
        );
      }
    }
    if (fixturesInExpected.size > 0) {
      baselineMismatch = true;
      for (const extra of fixturesInExpected) {
        process.stderr.write(`Mismatch ${extra}: present in baseline but not found in fixtures dir\n`);
      }
    }
  }

  const wFixture = Math.max('fixture'.length, ...rows.map((r) => r.fixture.length));
  const wScore = 5;
  const wLevel = 6;

  process.stdout.write(
    `${padRight('fixture', wFixture)}  ${padRight('score', wScore)}  ${padRight('level', wLevel)}  flags\n`,
  );
  process.stdout.write(
    `${'-'.repeat(wFixture)}  ${'-'.repeat(wScore)}  ${'-'.repeat(wLevel)}  -----\n`,
  );

  for (const r of rows) {
    if (!r.ok) {
      process.stdout.write(
        `${padRight(r.fixture, wFixture)}  ${padRight('ERR', wScore)}  ${padRight('', wLevel)}  ${r.error || ''}\n`,
      );
      continue;
    }

    process.stdout.write(
      `${padRight(r.fixture, wFixture)}  ${padRight(String(r.score ?? ''), wScore)}  ${padRight(String(r.level ?? ''), wLevel)}  ${r.flags || ''}\n`,
    );
  }

  if (checkBaseline) {
    if (baselineMismatch) {
      process.stderr.write(`Baseline mismatch vs ${baselinePath}. Re-run with --update-baseline if intentional.\n`);
      process.exit(1);
    }
    process.stdout.write(`Baseline OK (${baselinePath}).\n`);
  }

  if (rpcSmoke) {
    const failures = rows.filter((r) => !r.ok);
    const envMaxFailures = process.env.RPC_SMOKE_MAX_FAILURES;
    const maxAllowedFailures = envMaxFailures && /^\d+$/.test(envMaxFailures) ? Number(envMaxFailures) : 2;
    if (failures.length > maxAllowedFailures) {
      process.stderr.write(
        `RPC smoke test failed: ${failures.length} failures (allowed=${maxAllowedFailures}) over ${rows.length} fixtures.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `RPC smoke test OK: ${rows.length - failures.length}/${rows.length} fixtures succeeded (allowedFailures=${maxAllowedFailures}).\n`,
    );
  }
}

main();
