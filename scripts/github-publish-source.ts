import { runGitHubSourcePublicationCli } from "../lib/providers/github-source-publication";

try {
  const result = await runGitHubSourcePublicationCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "GitHub source publication failed without a safe diagnostic"}\n`,
  );
  process.exitCode = 1;
}
