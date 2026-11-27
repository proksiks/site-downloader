export type RepairTarget = { url: string; kind: 'resource' | 'page' }
export type RepairCandidate = RepairTarget & { description?: string }
export type FailedArchivePage = { url: string; message: string }
