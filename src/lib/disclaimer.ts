/**
 * Versioned disclaimer. The version a member must accept is
 * settings.disclaimer_version in the database; this file holds the wording
 * for each version. To change the wording: add a new version here, deploy,
 * then bump settings.disclaimer_version. Every member is asked to accept the
 * new version on their next visit.
 *
 * DRAFT WORDING for Tito's lawyer to finalise before launch. See
 * COMMUNITY-PLAN.md §6.
 */
export const DISCLAIMERS: Record<number, { title: string; points: string[] }> = {
  1: {
    title: "Before you continue",
    points: [
      "Tito Circle is educational and informational. Nothing here is personal financial advice, and no pick is tailored to your circumstances.",
      "Investing carries risk. You can lose some or all of the money you invest. Prices go down as well as up, and past performance is not a guide to future results.",
      "Do your own research before acting, and speak to a licensed adviser if you are unsure whether an investment is right for you.",
      "Tito may hold positions in securities discussed here. Where he does, it will be disclosed on the pick.",
      "Your membership is personal. Sharing picks, screenshots or your login outside the Circle ends your membership without refund.",
    ],
  },
};

export const PICK_FOOTER =
  "Educational content, not personal advice. Capital at risk. Do your own research.";
