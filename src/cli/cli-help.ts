export function hasHelpFlag(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}
