import { codeFromRepo, toDataSuffix } from "@celo/attribution-tags";

export const REPOSITORY = "JemIIahh/outbid";
export function builderCodes(env: Record<string, string | undefined>): string[] {
  const codes = [...new Set([env.OUTBID_ATTRIBUTION_CODE?.trim(), codeFromRepo(REPOSITORY)].filter((v): v is string => Boolean(v)))];
  toDataSuffix(codes); // Validate before any transaction can be signed.
  return codes;
}
export const attributionSuffix = (env: Record<string, string | undefined>) => toDataSuffix(builderCodes(env));
