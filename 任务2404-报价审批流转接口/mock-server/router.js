/**
 * Approval routing service - pure logic, no HTTP and no mutable state.
 *
 * Given a quote tier plus its amount, it returns the ordered approver step
 * sequence. Three tiers are supported:
 *   rep          - one self step, approved immediately at submit time
 *   supervisor   - one step handled by a supervisor
 *   site_manager - two sequential steps: supervisor, then club manager
 *
 * Every tier carries its own authority ceiling. A quote whose amount is above
 * the ceiling of its tier is refused with 422 before any approval is created.
 * All actors referenced here are synthetic fictional records.
 */

export const TIERS = ['rep', 'supervisor', 'site_manager'];

export const TIER_AUTHORITY = {
  rep: { max_amount: 1000, label: 'Advisor' },
  supervisor: { max_amount: 10000, label: 'Supervisor' },
  site_manager: { max_amount: 100000, label: 'Club manager' },
};

export const REP_APPROVAL_COMMENT = "Within advisor's authority";

const TIER_STEP_SPECS = {
  rep: [{ role: 'rep', label: 'Advisor (self)' }],
  supervisor: [{ role: 'supervisor', label: 'Supervisor' }],
  site_manager: [
    { role: 'supervisor', label: 'Supervisor' },
    { role: 'site_manager', label: 'Club manager' },
  ],
};

/**
 * Route one quote to its approval step sequence.
 * @returns {{ok:true, ...}} or {error:{status,code,message,...}}
 */
export function routeApproval(tier, amount, actors = [], submitterId = null) {
  const authority = TIER_AUTHORITY[tier];
  if (!authority) {
    return {
      error: {
        status: 422,
        code: 'UNKNOWN_TIER',
        message: `unsupported approval tier: ${String(tier)}`,
        tier: tier ?? null,
      },
    };
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) {
    return {
      error: {
        status: 422,
        code: 'INVALID_AMOUNT',
        message: 'quote amount must be a non-negative number',
        amount: amount ?? null,
      },
    };
  }
  if (value > authority.max_amount) {
    return {
      error: {
        status: 422,
        code: 'QUOTE_EXCEEDS_MAX_AUTHORITY',
        message: `amount exceeds the authority ceiling of tier ${tier}`,
        tier,
        amount: value,
        max_amount: authority.max_amount,
      },
    };
  }

  // The rep tier is within the submitting advisor's own authority: no routing
  // to another actor is needed and the approval is committed as approved.
  if (tier === 'rep') {
    return {
      ok: true,
      tier,
      auto_approve: true,
      comment: REP_APPROVAL_COMMENT,
      steps: [
        {
          step_no: 1,
          approver_id: submitterId,
          approver_role: 'rep',
          label: 'Advisor (self)',
        },
      ],
    };
  }

  const steps = [];
  for (const [index, spec] of TIER_STEP_SPECS[tier].entries()) {
    const candidate = actors.find(
      (a) => a.roles.includes(spec.role) && a.id !== submitterId
    );
    if (!candidate) {
      return {
        error: {
          status: 422,
          code: 'NO_APPROVER_AVAILABLE',
          message: `no actor available for role ${spec.role}`,
          role: spec.role,
        },
      };
    }
    steps.push({
      step_no: index + 1,
      approver_id: candidate.id,
      approver_role: spec.role,
      label: spec.label,
    });
  }

  return { ok: true, tier, auto_approve: false, comment: '', steps };
}

/** Exposed for the meta / OpenAPI document. */
export function tierRouteSummary() {
  return TIERS.map((tier) => ({
    tier,
    max_amount: TIER_AUTHORITY[tier].max_amount,
    auto_approve: tier === 'rep',
    steps: TIER_STEP_SPECS[tier].map((spec) => spec.role),
  }));
}
