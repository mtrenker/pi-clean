import type { Classification, FieldDescriptor, SiteRules, SurfaceContext, SurfaceVerdict } from "../site-rules.ts";

export function siteRules(): SiteRules;
export function classifyUrl(url: string): Classification;
export function authorizeSurface(classification: Classification, actionClass: string, context?: SurfaceContext): SurfaceVerdict;
export function isSensitiveField(field: FieldDescriptor): boolean;
export function isCommitControl(text: string): boolean;
export function permalinkFor(classification: Classification, url: string): string | undefined;
export function matchesAny(patterns: string[], value: string): boolean;
export function matchPattern(pattern: string, value: string): boolean;
