'use client';

import React, { useEffect, useState } from 'react';

type UserRole = 'MAKER_OPS' | 'CHECKER_LEAD';
type ConsoleTab = 'policies' | 'ledger' | 'brokers' | 'claims' | 'reconciliation'| 'mcp';

interface Broker {
  id: string;
  legal_name: string;
  dba_name: string;
  ein: string;
  contact_email: string;
  license_state: string;
  kyb_status: 'PENDING' | 'APPROVED' | 'REVIEW_REQUIRED' | 'FAILED';
  commission_rate_bps: number;
  kyb_failure_reason: string | null;
}

interface PolicyEvent {
  id: string;
  sequence_number: number;
  event_type: string;
  description: string;
  effective_date: string;
  recorded_at: string;
  active_days_in_term: number;
  prorated_premium_delta_cents: number;
  total_gross_delta_cents: number;
}

interface Policy {
  id: string;
  policy_number: string;
  insured_name: string;
  risk_state: string;
  product_line: string;
  effective_start_date: string;
  effective_end_date: string;
  term_days: number;
  status: string;
  coverage_limit_cents: number;
  deductible_cents: number;
  current_written_premium_cents: number;
  state_tax_cents: number;
  total_gross_charged_cents: number;
  stripe_payment_intent_id: string | null;
  broker_id: string;
  broker?: Broker;
  events?: PolicyEvent[];
}

interface LedgerEntry {
  id: string;
  account_code: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_cents: number;
}

interface LedgerTransaction {
  id: string;
  idempotency_key: string;
  event_category: string;
  description: string;
  effective_date: string;
  recorded_at: string;
  external_reference_id: string | null;
  entries: LedgerEntry[];
}

interface TrialBalance {
  accountCode: string;
  debitsCents: number;
  creditsCents: number;
  netCents: number;
  entryCount: number;
}

interface Claim {
  id: string;
  claim_number: string;
  claimant_name: string;
  loss_description: string;
  date_of_loss: string;
  status: string;
  current_reserve_cents: number;
  total_paid_cents: number;
  total_incurred_cents: number;
  policy?: Policy;
}

interface ApprovalRequest {
  id: string;
  action_type: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  amount_cents: number;
  summary: string;
  initiated_by_user: string;
  initiated_by_role: string;
  is_agent_initiated?: boolean;
  created_at: string;
  claim_id?: string | null;
}

interface ReconciliationBreak {
  id: string;
  reconciliation_run_id: string;
  source_rail: 'STRIPE_PAYMENTS' | 'CLAIM_PAYOUT_RAIL';
  external_reference_id: string;
  break_type: 'AMOUNT_MISMATCH' | 'MISSING_IN_LEDGER' | 'MISSING_AT_PROVIDER' | 'UNEXPECTED_RETURN_STATE';
  provider_amount_cents: number | null;
  ledger_amount_cents: number | null;
  variance_cents: number;
  explanation: string;
  status: 'OPEN_BREAK' | 'RESOLVED_BY_JOURNAL' | 'IGNORED';
  is_planted_test_break: boolean;
  detected_at: string;
}

interface ConsoleState {
  brokers: Broker[];
  policies: Policy[];
  claims: Claim[];
  approvals: ApprovalRequest[];
  reconciliationBreaks?: ReconciliationBreak[];
  ledger: {
    transactions: LedgerTransaction[];
    trialBalances: TrialBalance[];
    totalDebitsCents: number;
    totalCreditsCents: number;
    isBalanced: boolean;
  };
}

function formatCents(cents: number): string {
  const value = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

export default function OpsConsole() {
  const [role, setRole] = useState<UserRole>('MAKER_OPS');
  const [activeTab, setActiveTab] = useState<ConsoleTab>('policies');
  const [data, setData] = useState<ConsoleState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  // MCP Agent Workbench State
  const [mcpToolOutput, setMcpToolOutput] = useState<string | null>(null);
  const [mcpActiveTool, setMcpActiveTool] = useState<string | null>(null);
  const [mcpPayoutCents, setMcpPayoutCents] = useState(325000); // $3,250.00
  
  // Modal States
  const [isIssueOpen, setIsIssueOpen] = useState(false);
  const [isEndorseOpen, setIsEndorseOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);

  // Claims & Maker-Checker Modals
  const [isClaimModalOpen, setIsClaimModalOpen] = useState(false);
  const [isPayoutModalOpen, setIsPayoutModalOpen] = useState(false);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);

  // New Claim Form State
  const [newClaimPolicyId, setNewClaimPolicyId] = useState('');
  const [newDateOfLoss, setNewDateOfLoss] = useState('2026-06-15');
  const [newClaimantName, setNewClaimantName] = useState('Pacific Freight LLC');
  const [newLossDescription, setNewLossDescription] = useState('Forklift mast struck overhead fire suppression line');
  const [newInitialReserveCents, setNewInitialReserveCents] = useState(1500000); // $15,000

  // Payout Form State
  const [payoutAmountCents, setPayoutAmountCents] = useState(600000); // $6,000 (Triggers Maker-Checker)
  const [payoutRail, setPayoutRail] = useState<'ACH_DELAYED' | 'USDC_BASE_SEPOLIA'>('ACH_DELAYED');
  const [payoutNotes, setPayoutNotes] = useState('First tranche building damage repair');

  // Issue Form State
  const [newInsuredName, setNewInsuredName] = useState('Helios Propulsion Inc');
  const [newBrokerId, setNewBrokerId] = useState('');
  const [newRiskState, setNewRiskState] = useState('CA');
  const [newBasePremiumCents, setNewBasePremiumCents] = useState(1500000);
  const [newCoverageLimitCents, setNewCoverageLimitCents] = useState(100000000);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Endorsement Form State
  const [endorseEffectiveDate, setEndorseEffectiveDate] = useState('2026-07-01');
  const [endorseDeltaCents, setEndorseDeltaCents] = useState(400000);
  const [endorseLimitCents, setEndorseLimitCents] = useState(200000000);
  const [endorseDescription, setEndorseDescription] = useState(
    'Increase general aggregate limit and add transit coverage'
  );

  // Cancel Form State
  const [cancelDate, setCancelDate] = useState('2026-08-01');
  const [cancelMethod, setCancelMethod] = useState<'PRO_RATA' | 'SHORT_RATE'>('PRO_RATA');
  const [cancelReason, setCancelReason] = useState('Insured requested termination');

  async function loadState() {
    try {
      setLoading(true);
      const res = await fetch('/api/console/state');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);

      if (!newBrokerId && json.brokers?.length > 0) {
        const approved = json.brokers.find(
          (b: Broker) => b.kyb_status === 'APPROVED'
        );
        setNewBrokerId(approved?.id || json.brokers[0].id);
      }

      if (!newClaimPolicyId && json.policies?.length > 0) {
    const active = json.policies.find((p: Policy) => p.status === 'BOUND_ACTIVE');
    setNewClaimPolicyId(active?.id || json.policies[0].id);
  }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(`Failed to load system state: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadState();
  }, []);

  async function handleIssuePolicy(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch('/api/policies/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brokerId: newBrokerId,
          insuredName: newInsuredName,
          riskState: newRiskState,
          annualBasePremiumCents: newBasePremiumCents,
          coverageLimitCents: newCoverageLimitCents,
          autoConfirmWithTestCard: true,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Issuance failed');

      setActionSuccess(
        `Stripe PaymentIntent ${payload.paymentIntentId} created and confirmed for ${formatCents(
          payload.pricing.totalGrossChargedCents
        )}. Webhook dispatched to bind policy.`
      );
      setIsIssueOpen(false);
      setTimeout(loadState, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleEndorsePolicy(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPolicy) return;
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch(`/api/policies/${selectedPolicy.id}/endorse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endorsementEffectiveDate: endorseEffectiveDate,
          annualizedBasePremiumDeltaCents: Number(endorseDeltaCents),
          newCoverageLimitCents: Number(endorseLimitCents),
          description: endorseDescription,
          bypassMakerChecker: true,
          createdBy: role,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Endorsement failed');

      setActionSuccess(
        `Endorsement booked on ${selectedPolicy.policy_number}. Prorated delta: ${formatCents(
          payload.pricing.proratedBasePremiumDeltaCents
        )}.`
      );
      setIsEndorseOpen(false);
      loadState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancelPolicy(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPolicy) return;
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch(`/api/policies/${selectedPolicy.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cancellationEffectiveDate: cancelDate,
          cancellationMethod: cancelMethod,
          reason: cancelReason,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Cancellation failed');

      setActionSuccess(
        `Policy ${payload.policyNumber} cancelled. Refund of ${formatCents(
          payload.calculation.totalCustomerCashRefundCents
        )} executed through Stripe (${payload.stripeRefundId || 'manual settlement'}).`
      );
      setIsCancelOpen(false);
      loadState();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleOpenClaim(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch('/api/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policyId: newClaimPolicyId,
          dateOfLoss: newDateOfLoss,
          claimantName: newClaimantName,
          lossDescription: newLossDescription,
          initialReserveCents: Number(newInitialReserveCents),
          createdBy: role,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Claim intake failed');

      setActionSuccess(`Claim ${payload.claim.claim_number} opened with ${formatCents(payload.claim.current_reserve_cents)} reserve posted to ledger.`);
      setIsClaimModalOpen(false);
      loadState();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleInitiatePayout(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedClaim) return;
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch(`/api/claims/${selectedClaim.id}/payout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'INITIATE_PAYOUT',
          payoutAmountCents: Number(payoutAmountCents),
          payoutRail,
          notes: payoutNotes,
          initiatedByUser: role === 'MAKER_OPS' ? 'ops_maker@corgi.insure' : 'checker_lead@corgi.insure',
          initiatedByRole: role,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Payout initiation failed');

      if (payload.status === 'QUEUED_FOR_CHECKER_APPROVAL') {
        setActionSuccess(`Payout of ${formatCents(payoutAmountCents)} submitted and queued for Lead Checker sign-off.`);
      } else {
        setActionSuccess(`Payout of ${formatCents(payoutAmountCents)} settled on ${payload.claim.claim_number}.`);
      }
      setIsPayoutModalOpen(false);
      loadState();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReviewApproval(approvalId: string, decision: 'APPROVED' | 'REJECTED') {
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch(`/api/approvals/${approvalId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reviewedByUser: role === 'CHECKER_LEAD' ? 'lead_checker@corgi.insure' : 'ops_maker@corgi.insure',
          reviewedByRole: role,
          reviewNotes: decision === 'APPROVED' ? 'Approved by Underwriting Lead' : 'Rejected due to documentation deficit',
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Review submission failed');

      setActionSuccess(`Request ${approvalId.slice(0, 8)} marked as ${decision}.`);
      loadState();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSimulateReturn(claimId: string) {
    if (!confirm('Simulate ACH Return (R01 Insufficient Funds)? This will reverse settled cash and restore the claim reserve.')) return;
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch(`/api/claims/${claimId}/simulate-return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnCode: 'R01_INSUFFICIENT_FUNDS' }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Return simulation failed');

      setActionSuccess(`ACH Return (R01) processed on ${payload.claim.claim_number}. Reserve restored to ${formatCents(payload.claim.current_reserve_cents)}.`);
      loadState();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRunReconciliation() {
    setIsReconciling(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch('/api/reconciliation/run', { method: 'POST' });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Reconciliation run failed');

      setActionSuccess(
        `Reconciliation complete (${payload.runId}): ${payload.matchedCount} transactions matched cleanly. ` +
        `Active open breaks: ${payload.breaksDetectedCount}.`
      );
      loadState();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsReconciling(false);
    }
  }

  async function handlePlantTestBreak(
  scenario: 'MISMATCHED_CLAIM_PAYOUT' | 'UNBOOKED_STRIPE_CHARGE' | 'UNHANDLED_ACH_RETURN'
) {
  setIsSubmitting(true);
  setActionError(null);
  setActionSuccess(null);

  try {
    const res = await fetch('/api/reconciliation/plant-break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Failed to plant test break');

    setActionSuccess(payload.message);
    loadState();
  } catch (err: unknown) {
    setActionError(err instanceof Error ? err.message : String(err));
  } finally {
    setIsSubmitting(false);
  }
}

  async function handleResolveBreak(breakId: string) {
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch('/api/reconciliation/plant-break', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ breakId }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Failed to resolve break');

      setActionSuccess(`Break ${breakId.slice(0, 8)} marked as RESOLVED_BY_JOURNAL.`);
      loadState();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleInvokeMcpTool(toolName: string, args: Record<string, unknown>) {
    setIsSubmitting(true);
    setMcpActiveTool(toolName);
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args,
          },
        }),
      });

      const payload = await res.json();
      if (payload.error) {
        throw new Error(payload.error.message || 'MCP RPC invocation failed');
      }

      const textResult = payload.result?.content?.[0]?.text || JSON.stringify(payload.result, null, 2);
      setMcpToolOutput(textResult);

      if (toolName === 'propose_claim_payout') {
        setActionSuccess(
          `MCP Agent invoked "propose_claim_payout": Intercepted and queued in Maker-Checker Approvals (is_agent_initiated = true). Switch to Claims & Reserves as Lead Checker to review!`
        );
        loadState();
      } else {
        setActionSuccess(`MCP Read Tool "${toolName}" executed via JSON-RPC 2.0.`);
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#111111] font-sans antialiased">
      {/* Top Navigation */}
      <header className="border-b border-gray-200 bg-white sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <div className="flex items-center space-x-2">
              <span className="w-4 h-4 bg-[#FF7D32] rounded-sm inline-block"></span>
              <span className="font-bold text-lg tracking-tight">CORGI</span>
              <span className="text-xs uppercase tracking-wider text-gray-500 font-medium">
                Underwriting & Ledger
              </span>
            </div>

            <nav className="hidden md:flex space-x-1">
              {(
                [
                  ['policies', 'Policies'],
                  ['ledger', 'Double-Entry Ledger'],
                  ['brokers', 'Broker KYB'],
                  ['claims', 'Claims & Reserves'],
                  ['reconciliation', 'Reconciliation'],
                  ['mcp', 'MCP Agent'],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  onClick={() => setActiveTab(tabKey)}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    activeTab === tabKey
                      ? 'bg-gray-100 text-[#111111]'
                      : 'text-gray-600 hover:text-[#111111]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center space-x-4">
            {/* Ledger Invariant Status Indicator */}
            {data && (
              <div
                className={`hidden lg:flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-mono font-medium ${
                  data.ledger.isBalanced
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : 'bg-rose-50 text-rose-800 border border-rose-200'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    data.ledger.isBalanced ? 'bg-emerald-500' : 'bg-rose-500'
                  }`}
                ></span>
                <span>
                  {data.ledger.isBalanced
                    ? `Ledger Balanced: ${formatCents(
                        data.ledger.totalDebitsCents
                      )}`
                    : 'Invariant Broken: Debits != Credits'}
                </span>
              </div>
            )}

            {/* Role Switcher */}
            <div className="flex items-center bg-gray-100 p-1 rounded-lg border border-gray-200 text-xs">
              <button
                onClick={() => setRole('MAKER_OPS')}
                className={`px-3 py-1 rounded font-medium transition-all ${
                  role === 'MAKER_OPS'
                    ? 'bg-white text-[#111111] shadow-sm'
                    : 'text-gray-500 hover:text-[#111111]'
                }`}
              >
                Underwriting Maker
              </button>
              <button
                onClick={() => setRole('CHECKER_LEAD')}
                className={`px-3 py-1 rounded font-medium transition-all ${
                  role === 'CHECKER_LEAD'
                    ? 'bg-[#111111] text-white shadow-sm'
                    : 'text-gray-500 hover:text-[#111111]'
                }`}
              >
                Lead Checker
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Banner Messages */}
        {actionSuccess && (
          <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-md text-sm flex justify-between items-center">
            <span>{actionSuccess}</span>
            <button
              onClick={() => setActionSuccess(null)}
              className="text-emerald-700 font-bold ml-4"
            >
              x
            </button>
          </div>
        )}

        {actionError && (
          <div className="mb-6 p-4 bg-rose-50 border border-rose-200 text-rose-900 rounded-md text-sm flex justify-between items-center">
            <span>{actionError}</span>
            <button
              onClick={() => setActionError(null)}
              className="text-rose-700 font-bold ml-4"
            >
              x
            </button>
          </div>
        )}

        {/* TAB 1: POLICIES */}
        {activeTab === 'policies' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#111111]">
                  Policy Administration
                </h1>
                <p className="text-sm text-gray-500">
                  Active commercial liability contracts, real-time earned premium slices, and external payment rails.
                </p>
              </div>
              <button
                onClick={() => setIsIssueOpen(true)}
                className="bg-[#FF7D32] hover:bg-[#e66c28] text-white text-sm font-semibold px-4 py-2 rounded-md shadow-sm transition-colors"
              >
                + Issue New Policy (Stripe Card)
              </button>
            </div>

            {loading ? (
              <div className="bg-white border border-gray-200 rounded-md p-12 text-center text-sm text-gray-500">
                Loading live contracts from Neon PostgreSQL...
              </div>
            ) : (
              <div className="bg-white border border-gray-200 rounded-md overflow-hidden shadow-sm">
                <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
                  <thead className="bg-gray-50 text-gray-600 font-medium">
                    <tr>
                      <th className="py-3 px-4">Policy Number</th>
                      <th className="py-3 px-4">Insured / State</th>
                      <th className="py-3 px-4">Term</th>
                      <th className="py-3 px-4">Coverage Limit</th>
                      <th className="py-3 px-4">Gross Collected</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data?.policies.map((pol) => (
                      <tr key={pol.id} className="hover:bg-gray-50">
                        <td className="py-3 px-4 font-mono font-medium text-[#111111]">
                          {pol.policy_number}
                          <div className="text-xs text-gray-400 font-sans">
                            {pol.broker?.legal_name || 'Assigned Broker'}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-[#111111]">
                            {pol.insured_name}
                          </div>
                          <div className="text-xs text-gray-500">
                            State: {pol.risk_state} | {pol.product_line}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs font-mono">
                          {pol.effective_start_date} to {pol.effective_end_date}
                          <div className="text-gray-400">
                            {pol.term_days} days
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono">
                          {formatCents(pol.coverage_limit_cents)}
                          <div className="text-xs text-gray-400">
                            Ded: {formatCents(pol.deductible_cents)}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono font-medium text-[#111111]">
                          {formatCents(pol.total_gross_charged_cents)}
                          <div className="text-xs text-gray-400">
                            Base: {formatCents(pol.current_written_premium_cents)}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${
                              pol.status === 'BOUND_ACTIVE'
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'bg-gray-100 text-gray-600 border border-gray-200'
                            }`}
                          >
                            {pol.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right space-x-2">
                          {pol.status === 'BOUND_ACTIVE' && (
                            <>
                              <button
                                onClick={() => {
                                  setSelectedPolicy(pol);
                                  setIsEndorseOpen(true);
                                }}
                                className="text-xs text-gray-700 hover:text-[#FF7D32] border border-gray-200 px-2 py-1 rounded bg-white hover:border-[#FF7D32]"
                              >
                                Endorse
                              </button>
                              <button
                                onClick={() => {
                                  setSelectedPolicy(pol);
                                  setIsCancelOpen(true);
                                }}
                                className="text-xs text-rose-700 hover:text-rose-900 border border-rose-200 px-2 py-1 rounded bg-rose-50"
                              >
                                Cancel & Refund
                              </button>
                            </>
                          )}
                          <button
                            onClick={() =>
                              alert(
                                'Declarations PDF Engine (*) will stream bi-temporal document state in Phase 4.'
                              )
                            }
                            className="text-xs text-gray-400 border border-gray-200 px-2 py-1 rounded bg-gray-50"
                            title="Phase 4 Dynamic PDF Generation"
                          >
                            PDF Dec *
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: DOUBLE-ENTRY LEDGER */}
        {activeTab === 'ledger' && (
          <div>
            <div className="mb-6">
              <h1 className="text-xl font-bold tracking-tight text-[#111111]">
                Double-Entry Ledger & Chart of Accounts
              </h1>
              <p className="text-sm text-gray-500">
                Append-only financial entries. Protected by PostgreSQL database triggers preventing row updates or deletions.
              </p>
            </div>

            {/* Trial Balance Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              {data?.ledger.trialBalances.map((tb) => (
                <div
                  key={tb.accountCode}
                  className="bg-white border border-gray-200 p-4 rounded-md shadow-sm"
                >
                  <div className="text-xs font-mono text-gray-500 truncate">
                    {tb.accountCode}
                  </div>
                  <div className="text-lg font-bold font-mono mt-1 text-[#111111]">
                    {formatCents(Math.abs(tb.netCents))}
                    <span className="text-xs font-normal text-gray-400 ml-2">
                      {tb.netCents >= 0 ? 'DR' : 'CR'}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-gray-400 flex justify-between">
                    <span>Debits: {formatCents(tb.debitsCents)}</span>
                    <span>Credits: {formatCents(tb.creditsCents)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Recent Journal Transactions */}
            <div className="bg-white border border-gray-200 rounded-md overflow-hidden shadow-sm">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 font-semibold text-sm text-[#111111]">
                Recent Journal Transactions (Audit Log)
              </div>
              <div className="divide-y divide-gray-100">
                {data?.ledger.transactions.map((tx) => (
                  <div key={tx.id} className="p-4 hover:bg-gray-50">
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="inline-block px-2 py-0.5 text-xs font-mono bg-gray-100 text-gray-700 rounded mr-2">
                          {tx.event_category}
                        </span>
                        <span className="text-sm font-medium text-[#111111]">
                          {tx.description}
                        </span>
                        <div className="text-xs text-gray-400 font-mono mt-0.5">
                          Idempotency Key: {tx.idempotency_key} | Ref:{' '}
                          {tx.external_reference_id || 'INTERNAL'}
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 font-mono text-right">
                        <div>Effective: {tx.effective_date}</div>
                        <div>
                          Recorded:{' '}
                          {new Date(tx.recorded_at).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>

                    {/* Entry Lines */}
                    <div className="mt-3 pl-4 border-l-2 border-gray-200 space-y-1">
                      {tx.entries.map((entry) => (
                        <div
                          key={entry.id}
                          className="flex justify-between text-xs font-mono"
                        >
                          <span
                            className={
                              entry.direction === 'DEBIT'
                                ? 'text-gray-900 font-medium'
                                : 'text-gray-600 pl-4'
                            }
                          >
                            {entry.direction === 'DEBIT' ? 'DR ' : 'CR '}
                            {entry.account_code}
                          </span>
                          <span className="font-semibold text-gray-800">
                            {formatCents(entry.amount_cents)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: BROKER KYB */}
        {activeTab === 'brokers' && (
          <div>
            <div className="mb-6">
              <h1 className="text-xl font-bold tracking-tight text-[#111111]">
                Statutory Broker Verification & KYB Gating
              </h1>
              <p className="text-sm text-gray-500">
                Middesk-aligned verification schema. Unverified brokers are blocked at underwriting from binding business.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {data?.brokers.map((broker) => (
                <div
                  key={broker.id}
                  className="bg-white border border-gray-200 rounded-md p-5 shadow-sm flex flex-col justify-between"
                >
                  <div>
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold text-sm text-[#111111]">
                        {broker.legal_name}
                      </h3>
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-semibold ${
                          broker.kyb_status === 'APPROVED'
                            ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                            : broker.kyb_status === 'PENDING'
                            ? 'bg-amber-50 text-amber-800 border border-amber-200'
                            : 'bg-rose-50 text-rose-800 border border-rose-200'
                        }`}
                      >
                        {broker.kyb_status}
                      </span>
                    </div>

                    <div className="text-xs text-gray-500 space-y-1 mt-3">
                      <div>DBA: {broker.dba_name}</div>
                      <div>EIN: {broker.ein}</div>
                      <div>Contact: {broker.contact_email}</div>
                      <div>License State: {broker.license_state}</div>
                      <div className="font-mono text-gray-700">
                        Commission Rate: {broker.commission_rate_bps / 100}%
                      </div>
                    </div>

                    {broker.kyb_failure_reason && (
                      <div className="mt-3 p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800">
                        <strong>Reason:</strong> {broker.kyb_failure_reason}
                      </div>
                    )}
                  </div>

                  <div className="mt-6 pt-4 border-t border-gray-100 flex space-x-2">
                    <button
                      onClick={() =>
                        alert(
                          'KYB Provider Re-check (*) will connect to live verification session in Phase 5.'
                        )
                      }
                      className="text-xs border border-gray-200 bg-gray-50 text-gray-600 px-3 py-1.5 rounded hover:bg-gray-100 w-full"
                    >
                      Verify KYB *
                    </button>
                    <button
                      onClick={() =>
                        alert(
                          'Commission Statement Generator (*) will render monthly statutory tie-out in Phase 5.'
                        )
                      }
                      className="text-xs border border-gray-200 bg-gray-50 text-gray-600 px-3 py-1.5 rounded hover:bg-gray-100 w-full"
                    >
                      Statement *
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 4: CLAIMS */}
        {activeTab === 'claims' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#111111]">
                  Claims Reserving & Maker-Checker Payout Rail
                </h1>
                <p className="text-sm text-gray-500">
                  Loss reserves, statutory solvency checks, and maker-checker approval controls.
                </p>
              </div>
              <button
                onClick={() => setIsClaimModalOpen(true)}
                className="bg-[#FF7D32] hover:bg-[#e66c28] text-white text-sm font-semibold px-4 py-2 rounded-md shadow-sm transition-colors"
              >
                + Open New Claim
              </button>
            </div>

            {/* Maker-Checker Approval Queue */}
            {data?.approvals && data.approvals.filter(a => a.status === 'PENDING').length > 0 && (
              <div className="mb-6 bg-amber-50 border border-amber-300 rounded-md p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center space-x-2">
                    <span className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-pulse"></span>
                    <h2 className="text-sm font-bold text-amber-950 uppercase tracking-wide">
                      Pending Maker-Checker Approvals Queue ({data.approvals.filter(a => a.status === 'PENDING').length})
                    </h2>
                  </div>
                  <span className="text-xs text-amber-800">
                    Current Active Role: <strong>{role === 'CHECKER_LEAD' ? 'Lead Checker (Authorized)' : 'Underwriting Maker (Cannot Self-Approve)'}</strong>
                  </span>
                </div>

                <div className="space-y-2">
                  {data.approvals.filter(a => a.status === 'PENDING').map((req) => (
                    <div key={req.id} className="bg-white border border-amber-200 rounded p-3 flex justify-between items-center text-sm">
                      <div>
                        <div className="font-semibold text-gray-900">{req.summary}</div>
                        {(req.is_agent_initiated || req.initiated_by_role === 'MCP_AGENT') && (
                            <span className="px-2 py-0.5 text-[10px] font-bold uppercase bg-purple-100 text-purple-800 border border-purple-300 rounded">
                              MCP Agent Initiated
                            </span>
                          )}
                        <div className="text-xs text-gray-500 font-mono">
                          Initiated by: {req.initiated_by_user} ({req.initiated_by_role}) | Amount: {formatCents(req.amount_cents)}
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => handleReviewApproval(req.id, 'APPROVED')}
                          disabled={isSubmitting}
                          className="px-3 py-1 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded disabled:opacity-50"
                        >
                          Approve Payout
                        </button>
                        <button
                          onClick={() => handleReviewApproval(req.id, 'REJECTED')}
                          disabled={isSubmitting}
                          className="px-3 py-1 bg-rose-700 hover:bg-rose-800 text-white text-xs font-semibold rounded disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white border border-gray-200 rounded-md overflow-hidden shadow-sm">
              <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
                <thead className="bg-gray-50 text-gray-600 font-medium">
                  <tr>
                    <th className="py-3 px-4">Claim Number</th>
                    <th className="py-3 px-4">Claimant / Loss</th>
                    <th className="py-3 px-4">Date of Loss</th>
                    <th className="py-3 px-4">Current Reserve</th>
                    <th className="py-3 px-4">Total Paid</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data?.claims.map((clm) => (
                    <tr key={clm.id} className="hover:bg-gray-50">
                      <td className="py-3 px-4 font-mono font-medium text-[#111111]">
                        {clm.claim_number}
                        {clm.policy && (
                          <div className="text-xs text-gray-400 font-sans">
                            {clm.policy.policy_number}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-[#111111]">{clm.claimant_name}</div>
                        <div className="text-xs text-gray-500 line-clamp-1">{clm.loss_description}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs">{clm.date_of_loss}</td>
                      <td className="py-3 px-4 font-mono font-semibold text-amber-700">
                        {formatCents(clm.current_reserve_cents)}
                      </td>
                      <td className="py-3 px-4 font-mono text-gray-600">
                        {formatCents(clm.total_paid_cents)}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${
                          clm.status === 'CLOSED_PAID'
                            ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                            : clm.status === 'PENDING_APPROVAL'
                            ? 'bg-purple-50 text-purple-800 border border-purple-200'
                            : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}>
                          {clm.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right space-x-2">
                        {clm.status !== 'CLOSED_PAID' && clm.status !== 'PENDING_APPROVAL' && (
                          <button
                            onClick={() => {
                              setSelectedClaim(clm);
                              setIsPayoutModalOpen(true);
                            }}
                            className="text-xs text-[#FF7D32] border border-[#FF7D32] px-2.5 py-1 rounded hover:bg-orange-50 font-medium"
                          >
                            Initiate Payout
                          </button>
                        )}
                        {clm.total_paid_cents > 0 && (
                          <button
                            onClick={() => handleSimulateReturn(clm.id)}
                            className="text-xs text-rose-700 border border-rose-300 bg-rose-50 px-2 py-1 rounded hover:bg-rose-100 font-medium"
                            title="Simulate ACH R01 return bounce"
                          >
                            Simulate R01 Bounce
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 5: RECONCILIATION & BREAKS (NON-NEGOTIABLE #7) */}
        {activeTab === 'reconciliation' && (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#111111]">
                  Reconciliation & Exception Engine
                </h1>
                <p className="text-sm text-gray-500">
                  Two-way diff between External Provider Truth (Stripe API & ACH Bank Clearing Feed) and Internal General Ledger.
                </p>
              </div>

              <div className="flex items-center space-x-2">
                {/* Debrief Live-Fire Break Generator */}
                <select
               onChange={(e) => {
                 if (e.target.value) {
                   handlePlantTestBreak(e.target.value as any);
                   e.target.value = '';
                 }
               }}
               defaultValue=""
               className="text-xs border border-gray-300 rounded px-2.5 py-2 bg-white text-gray-700 outline-none"
             >
               <option value="" disabled>+ Plant Real Source Discrepancy (Debrief) *</option>
               <option value="MISMATCHED_CLAIM_PAYOUT">Mismatched Claim Payout ($2,500 Ledger vs $2,485 Bank)</option>
               <option value="UNBOOKED_STRIPE_CHARGE">Live Stripe Charge Missing in Ledger ($8,450.00)</option>
               <option value="UNHANDLED_ACH_RETURN">Unhandled R03 ACH Bounce ($4,200.00)</option>
             </select>

                <button
                  onClick={handleRunReconciliation}
                  disabled={isReconciling}
                  className="bg-[#FF7D32] hover:bg-[#e66c28] text-white text-sm font-semibold px-4 py-2 rounded-md shadow-sm transition-colors disabled:opacity-50"
                >
                  {isReconciling ? 'Running Diff Engine...' : 'Run Reconciliation'}
                </button>
              </div>
            </div>

            {/* Reconciliation Health Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-white border border-gray-200 p-4 rounded-md shadow-sm">
                <div className="text-xs text-gray-500 font-medium">External Provider Truth</div>
                <div className="text-sm font-bold text-gray-900 mt-1">Stripe API + ACH Feed</div>
                <div className="text-xs text-emerald-600 mt-1">Direct API & Clearing Log</div>
              </div>

              <div className="bg-white border border-gray-200 p-4 rounded-md shadow-sm">
                <div className="text-xs text-gray-500 font-medium">Internal Ledger Account</div>
                <div className="text-xs font-mono font-bold text-gray-900 mt-1 truncate">ASSET:OPERATING_CASH_SETTLED</div>
                <div className="text-xs text-gray-500 mt-1">Postgres Immutable Log</div>
              </div>

              <div className="bg-white border border-gray-200 p-4 rounded-md shadow-sm">
                <div className="text-xs text-gray-500 font-medium">Open Reconciliation Breaks</div>
                <div className={`text-xl font-bold font-mono mt-1 ${
                  (data?.reconciliationBreaks?.filter(b => b.status === 'OPEN_BREAK').length || 0) > 0
                    ? 'text-rose-600'
                    : 'text-emerald-600'
                }`}>
                  {data?.reconciliationBreaks?.filter(b => b.status === 'OPEN_BREAK').length || 0}
                </div>
                <div className="text-xs text-gray-400 mt-1">Exceptions requiring tie-out</div>
              </div>

              <div className="bg-white border border-gray-200 p-4 rounded-md shadow-sm">
                <div className="text-xs text-gray-500 font-medium">Reconciliation Invariant</div>
                <div className="text-sm font-bold text-gray-900 mt-1">
                  {(data?.reconciliationBreaks?.filter(b => b.status === 'OPEN_BREAK').length || 0) === 0
                    ? '100% In-Balance'
                    : 'Discrepancy Detected'}
                </div>
                <div className="text-xs text-gray-400 mt-1">Debrief live-fire ready</div>
              </div>
            </div>

            {/* Reconciliation Breaks Table */}
            <div className="bg-white border border-gray-200 rounded-md overflow-hidden shadow-sm">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 font-semibold text-sm text-[#111111] flex justify-between items-center">
                <span>Detected Ledger & Provider Discrepancies</span>
                <span className="text-xs font-normal text-gray-500 font-mono">Table: reconciliation_breaks</span>
              </div>

              {(!data?.reconciliationBreaks || data.reconciliationBreaks.length === 0) ? (
                <div className="p-12 text-center text-sm text-gray-500">
                  No breaks detected. Click <strong>"Run Reconciliation"</strong> to diff live Stripe transactions and ACH clearing feeds against the general ledger.
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {data.reconciliationBreaks.map((brk) => (
                    <div key={brk.id} className="p-4 hover:bg-gray-50 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className={`px-2 py-0.5 text-xs font-semibold rounded ${
                            brk.status === 'OPEN_BREAK'
                              ? 'bg-rose-50 text-rose-800 border border-rose-200'
                              : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          }`}>
                            {brk.break_type}
                          </span>
                          <span className="text-xs font-mono text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                            {brk.source_rail}
                          </span>
                          {brk.is_planted_test_break && (
                            <span className="text-xs bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.2 rounded font-medium">
                              Live-Fire Test Break
                            </span>
                          )}
                          <span className="text-xs text-gray-400">
                            {new Date(brk.detected_at).toLocaleTimeString()}
                          </span>
                        </div>

                        <div className="text-sm font-medium text-gray-900">
                          {brk.explanation}
                        </div>

                        <div className="text-xs font-mono text-gray-500 flex gap-4">
                          <span>Ref: {brk.external_reference_id}</span>
                          <span>Provider: {brk.provider_amount_cents !== null ? formatCents(brk.provider_amount_cents) : 'N/A'}</span>
                          <span>Ledger: {brk.ledger_amount_cents !== null ? formatCents(brk.ledger_amount_cents) : 'N/A'}</span>
                          <span className="font-semibold text-rose-700">Variance: {formatCents(Math.abs(brk.variance_cents))}</span>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2">
                        {brk.status === 'OPEN_BREAK' ? (
                          <button
                            onClick={() => handleResolveBreak(brk.id)}
                            disabled={isSubmitting}
                            className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:border-gray-400 text-gray-700 font-medium rounded shadow-sm disabled:opacity-50"
                          >
                            Mark Resolved
                          </button>
                        ) : (
                          <span className="text-xs text-emerald-700 font-semibold px-2 py-1 bg-emerald-50 rounded">
                            RESOLVED
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 6: MCP AGENT SURFACE (NON-NEGOTIABLE #8) */}
        {activeTab === 'mcp' && (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-[#111111]">
                  Model Context Protocol (MCP) Agent Surface
                </h1>
                <p className="text-sm text-gray-500">
                  Live JSON-RPC 2.0 MCP Server (<code className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">POST /api/mcp</code>) exposing 3 Read Tools and 1 Maker-Checker Gated Write Tool.
                </p>
              </div>
              <a
                href="/api/mcp"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-mono border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 px-3 py-2 rounded shadow-sm"
              >
                View Live MCP Manifest (/api/mcp) ↗
              </a>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Tool Invocation Cards */}
              <div className="space-y-4">
                <div className="bg-white border border-gray-200 rounded-md p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm font-bold text-[#111111]">1. get_policy_details</span>
                    <span className="text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded font-semibold">READ TOOL</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    Queries policy terms, limits, deductible, broker KYB status, and immutable endorsement slices.
                  </p>
                  <button
                    onClick={() =>
                      handleInvokeMcpTool('get_policy_details', {
                        policyIdentifier: data?.policies?.[0]?.policy_number || 'CORGI-CGL-2026-0001',
                      })
                    }
                    disabled={isSubmitting}
                    className="text-xs bg-[#111111] hover:bg-black text-white font-semibold px-3 py-1.5 rounded disabled:opacity-50"
                  >
                    Invoke via MCP JSON-RPC ({data?.policies?.[0]?.policy_number || 'Latest Policy'})
                  </button>
                </div>

                <div className="bg-white border border-gray-200 rounded-md p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm font-bold text-[#111111]">2. get_ledger_trial_balance</span>
                    <span className="text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded font-semibold">READ TOOL</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    Retrieves real-time double-entry account balances and verifies the global Debit === Credit invariant.
                  </p>
                  <button
                    onClick={() =>
                      handleInvokeMcpTool('get_ledger_trial_balance', {
                        includeRecentTransactionsLimit: 5,
                      })
                    }
                    disabled={isSubmitting}
                    className="text-xs bg-[#111111] hover:bg-black text-white font-semibold px-3 py-1.5 rounded disabled:opacity-50"
                  >
                    Invoke via MCP JSON-RPC
                  </button>
                </div>

                <div className="bg-white border border-gray-200 rounded-md p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm font-bold text-[#111111]">3. get_claim_summary</span>
                    <span className="text-xs bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded font-semibold">READ TOOL</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    Inspects claim loss reserve, settled disbursements, and remaining policy limit solvency headroom.
                  </p>
                  <button
                    onClick={() =>
                      handleInvokeMcpTool('get_claim_summary', {
                        claimIdentifier: data?.claims?.[0]?.claim_number || 'CLM-2026-0001',
                      })
                    }
                    disabled={isSubmitting}
                    className="text-xs bg-[#111111] hover:bg-black text-white font-semibold px-3 py-1.5 rounded disabled:opacity-50"
                  >
                    Invoke via MCP JSON-RPC ({data?.claims?.[0]?.claim_number || 'Latest Claim'})
                  </button>
                </div>

                <div className="bg-purple-50/60 border border-purple-200 rounded-md p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm font-bold text-purple-950">4. propose_claim_payout</span>
                    <span className="text-xs bg-purple-100 text-purple-800 border border-purple-300 px-2 py-0.5 rounded font-semibold">
                      WRITE TOOL (MAKER-CHECKER GATED)
                    </span>
                  </div>
                  <p className="text-xs text-purple-900 mb-3">
                    Autonomous agent proposes a claim payout. Hard-gated by Non-Negotiable #6 & #8: lands in <code className="font-mono">approval_requests</code> (<code className="font-mono">is_agent_initiated = true</code>) and cannot self-approve.
                  </p>
                  <div className="flex items-center space-x-2 mb-3">
                    <input
                      type="number"
                      step="5000"
                      value={mcpPayoutCents}
                      onChange={(e) => setMcpPayoutCents(Number(e.target.value))}
                      className="w-36 text-xs font-mono border border-purple-300 bg-white rounded px-2.5 py-1.5"
                    />
                    <span className="text-xs font-mono text-purple-900 font-semibold">
                      ({formatCents(mcpPayoutCents)})
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      handleInvokeMcpTool('propose_claim_payout', {
                        claimIdentifier: data?.claims?.[0]?.claim_number || 'CLM-2026-0001',
                        payoutAmountCents: mcpPayoutCents,
                        payoutRail: 'ACH_DELAYED',
                        reasoningNotes:
                          'Autonomous agent verified repair invoice and coverage schedule; proposing disbursement for Lead Checker sign-off.',
                      })
                    }
                    disabled={isSubmitting}
                    className="text-xs bg-[#FF7D32] hover:bg-[#e66c28] text-white font-semibold px-3 py-1.5 rounded shadow-sm disabled:opacity-50"
                  >
                    Agent: Propose Payout into Approval Queue
                  </button>
                </div>
              </div>

              {/* Live JSON-RPC Output Inspector */}
              <div className="bg-[#111111] text-gray-100 rounded-md p-4 font-mono text-xs overflow-auto max-h-[560px] border border-gray-800">
                <div className="flex justify-between items-center pb-2 mb-3 border-b border-gray-800 text-gray-400">
                  <span>MCP JSON-RPC 2.0 Response Inspector</span>
                  {mcpActiveTool && <span className="text-[#FF7D32]">Tool: {mcpActiveTool}</span>}
                </div>
                <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                  {mcpToolOutput ||
                    '// Click any MCP tool on the left to execute a live JSON-RPC 2.0 "tools/call" request against /api/mcp...'}
                </pre>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* MODAL 1: ISSUE POLICY */}
      {isIssueOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 border border-gray-200">
            <h2 className="text-lg font-bold text-[#111111] mb-1">
              Issue Policy & Collect via Stripe
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              Charges Stripe Sandbox (pm_card_visa), computes state surplus lines taxes, and binds the policy in the ledger.
            </p>

            <form onSubmit={handleIssuePolicy} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Insured Business Legal Name
                </label>
                <input
                  type="text"
                  required
                  value={newInsuredName}
                  onChange={(e) => setNewInsuredName(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Broker (KYB Gate)
                  </label>
                  <select
                    value={newBrokerId}
                    onChange={(e) => setNewBrokerId(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                  >
                    {data?.brokers.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.legal_name} ({b.kyb_status})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Risk State
                  </label>
                  <select
                    value={newRiskState}
                    onChange={(e) => setNewRiskState(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                  >
                    <option value="CA">California (3.0% Tax + 0.18% Stamp)</option>
                    <option value="NY">New York (3.6% Tax + 0.15% Stamp)</option>
                    <option value="TX">Texas (4.85% Tax + 0.04% Stamp)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Annual Base Premium (Cents)
                  </label>
                  <input
                    type="number"
                    step="1000"
                    required
                    value={newBasePremiumCents}
                    onChange={(e) =>
                      setNewBasePremiumCents(Number(e.target.value))
                    }
                    className="w-full text-sm font-mono border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                  />
                  <span className="text-xs text-gray-400">
                    {formatCents(newBasePremiumCents)}
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Coverage Limit (Cents)
                  </label>
                  <input
                    type="number"
                    step="100000"
                    required
                    value={newCoverageLimitCents}
                    onChange={(e) =>
                      setNewCoverageLimitCents(Number(e.target.value))
                    }
                    className="w-full text-sm font-mono border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                  />
                  <span className="text-xs text-gray-400">
                    {formatCents(newCoverageLimitCents)}
                  </span>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsIssueOpen(false)}
                  className="px-4 py-2 border border-gray-200 text-sm font-medium rounded hover:bg-gray-50 text-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-[#FF7D32] hover:bg-[#e66c28] text-white text-sm font-semibold rounded disabled:opacity-50"
                >
                  {isSubmitting ? 'Confirming with Stripe...' : 'Collect & Bind'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: ENDORSE POLICY */}
      {isEndorseOpen && selectedPolicy && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 border border-gray-200">
            <h2 className="text-lg font-bold text-[#111111] mb-1">
              Mid-Term Endorsement: {selectedPolicy.policy_number}
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              Prorates premium change from the legal effective date to the policy term end date.
            </p>

            <form onSubmit={handleEndorsePolicy} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Endorsement Effective Date
                </label>
                <input
                  type="date"
                  required
                  value={endorseEffectiveDate}
                  onChange={(e) => setEndorseEffectiveDate(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Annualized Premium Delta (Cents)
                </label>
                <input
                  type="number"
                  step="1000"
                  required
                  value={endorseDeltaCents}
                  onChange={(e) => setEndorseDeltaCents(Number(e.target.value))}
                  className="w-full text-sm font-mono border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
                <span className="text-xs text-gray-400">
                  Full-term annualized change: {formatCents(endorseDeltaCents)}
                </span>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  New Coverage Limit (Cents)
                </label>
                <input
                  type="number"
                  step="10000000"
                  required
                  value={endorseLimitCents}
                  onChange={(e) => setEndorseLimitCents(Number(e.target.value))}
                  className="w-full text-sm font-mono border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Description of Coverage Change
                </label>
                <textarea
                  required
                  rows={2}
                  value={endorseDescription}
                  onChange={(e) => setEndorseDescription(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsEndorseOpen(false)}
                  className="px-4 py-2 border border-gray-200 text-sm font-medium rounded hover:bg-gray-50 text-gray-700"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-[#111111] hover:bg-black text-white text-sm font-semibold rounded disabled:opacity-50"
                >
                  {isSubmitting ? 'Calculating...' : 'Apply Endorsement'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: CANCEL & REFUND */}
      {isCancelOpen && selectedPolicy && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 border border-gray-200">
            <h2 className="text-lg font-bold text-rose-900 mb-1">
              Cancel Policy & Execute Stripe Refund
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              Calculates unearned premium, invokes stripe.refunds.create, and claws back unearned broker commission.
            </p>

            <form onSubmit={handleCancelPolicy} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Cancellation Effective Date
                </label>
                <input
                  type="date"
                  required
                  value={cancelDate}
                  onChange={(e) => setCancelDate(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-rose-600 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Cancellation Method
                </label>
                <select
                  value={cancelMethod}
                  onChange={(e) =>
                    setCancelMethod(e.target.value as 'PRO_RATA' | 'SHORT_RATE')
                  }
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-rose-600 outline-none"
                >
                  <option value="PRO_RATA">
                    Pro-Rata (Standard carrier-initiated full unearned refund)
                  </option>
                  <option value="SHORT_RATE">
                    Short-Rate (Insured-initiated with 10% penalty retained)
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Reason for Cancellation
                </label>
                <input
                  type="text"
                  required
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-rose-600 outline-none"
                />
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
                Notice: Statutory carrier fees and state stamping fees remain non-refundable. Only unearned base premium and pro-rated state tax will be returned.
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsCancelOpen(false)}
                  className="px-4 py-2 border border-gray-200 text-sm font-medium rounded hover:bg-gray-50 text-gray-700"
                >
                  Aborted
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-rose-700 hover:bg-rose-800 text-white text-sm font-semibold rounded disabled:opacity-50"
                >
                  {isSubmitting ? 'Executing Refund...' : 'Confirm Cancellation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 4: OPEN CLAIM */}
      {isClaimModalOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 border border-gray-200">
            <h2 className="text-lg font-bold text-[#111111] mb-1">
              Open Claim & Establish Loss Reserve
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              Verifies date of loss against policy terms and posts initial balanced loss reserve to the double-entry ledger.
            </p>

            <form onSubmit={handleOpenClaim} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Target Policy
                </label>
                <select
                  value={newClaimPolicyId}
                  onChange={(e) => setNewClaimPolicyId(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                >
                  {data?.policies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.policy_number} - {p.insured_name} ({p.status})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Date of Loss
                  </label>
                  <input
                    type="date"
                    required
                    value={newDateOfLoss}
                    onChange={(e) => setNewDateOfLoss(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Initial Loss Reserve (Cents)
                  </label>
                  <input
                    type="number"
                    step="10000"
                    required
                    value={newInitialReserveCents}
                    onChange={(e) => setNewInitialReserveCents(Number(e.target.value))}
                    className="w-full text-sm font-mono border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                  />
                  <span className="text-xs text-gray-400">
                    {formatCents(newInitialReserveCents)}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Claimant Name
                </label>
                <input
                  type="text"
                  required
                  value={newClaimantName}
                  onChange={(e) => setNewClaimantName(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Incident / Loss Description
                </label>
                <textarea
                  required
                  rows={2}
                  value={newLossDescription}
                  onChange={(e) => setNewLossDescription(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsClaimModalOpen(false)}
                  className="px-4 py-2 border border-gray-200 text-sm font-medium rounded hover:bg-gray-50 text-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-[#FF7D32] hover:bg-[#e66c28] text-white text-sm font-semibold rounded disabled:opacity-50"
                >
                  {isSubmitting ? 'Opening Claim...' : 'Open Claim & Post Reserve'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 5: INITIATE PAYOUT */}
      {isPayoutModalOpen && selectedClaim && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 border border-gray-200">
            <h2 className="text-lg font-bold text-[#111111] mb-1">
              Disburse Claim Payout: {selectedClaim.claim_number}
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              Draws down loss reserve and releases settled funds. Payouts require dual Maker-Checker review.
            </p>

            <form onSubmit={handleInitiatePayout} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Payout Amount (Cents)
                </label>
                <input
                  type="number"
                  step="1000"
                  required
                  value={payoutAmountCents}
                  onChange={(e) => setPayoutAmountCents(Number(e.target.value))}
                  className="w-full text-sm font-mono border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
                <div className="flex justify-between text-xs mt-1">
                  <span className="font-semibold text-gray-900">{formatCents(payoutAmountCents)}</span>
                  <span className="text-gray-400">Available Reserve: {formatCents(selectedClaim.current_reserve_cents)}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Payout Settlement Rail
                </label>
                <select
                  value={payoutRail}
                  onChange={(e) => setPayoutRail(e.target.value as 'ACH_DELAYED' | 'USDC_BASE_SEPOLIA')}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                >
                  <option value="ACH_DELAYED">ACH Direct Deposit (1 to 3 Business Days)</option>
                  <option value="USDC_BASE_SEPOLIA">Base Sepolia Testnet USDC (Instant Crypto Settlement)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Payment Disbursement Notes
                </label>
                <input
                  type="text"
                  required
                  value={payoutNotes}
                  onChange={(e) => setPayoutNotes(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded px-3 py-1.5 focus:border-[#FF7D32] outline-none"
                />
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
                Maker-Checker Notice: Submitting will queue this payout into the approval queue. Only a Lead Checker can finalize the ledger write.
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsPayoutModalOpen(false)}
                  className="px-4 py-2 border border-gray-200 text-sm font-medium rounded hover:bg-gray-50 text-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-[#111111] hover:bg-black text-white text-sm font-semibold rounded disabled:opacity-50"
                >
                  {isSubmitting ? 'Submitting...' : 'Submit for Checker Review'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}