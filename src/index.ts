import Zip from "adm-zip";
import * as fs from "fs";
import { dirname, resolve } from "path";

import * as artifact from "@actions/artifact";
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { getDefaultProvider } from "@ethersproject/providers";

import { checkLayouts } from "./check";
import { diffLevels, diffTitles, formatDiff } from "./format";
import { createLayout, parseSource, parseLayout } from "./input";
import { StorageLayoutDiffType } from "./types";

const token = process.env.GITHUB_TOKEN || core.getInput("token");
const baseBranch = core.getInput("base");
const headBranch = core.getInput("head");
const contract = core.getInput("contract");
const address = core.getInput("address");
const rpcUrl = core.getInput("rpcUrl");
const failOnRemoval = core.getInput("failOnRemoval") === "true";
const baseDir = core.getInput("baseDir");

const contractEscaped = contract.replace(/\//g, "_").replace(/:/g, "-");
const getReportPath = (branch: string, baseName: string) =>
  `${branch.replace(/[/\\]/g, "-")}.${baseName}.json`;

const baseReport = getReportPath(baseBranch, contractEscaped);
const outReport = getReportPath(headBranch, contractEscaped);

const octokit = getOctokit(token);
const artifactClient = artifact.create();

const { owner, repo } = context.repo;
const repository = owner + "/" + repo;

const provider = rpcUrl ? getDefaultProvider(rpcUrl) : undefined;

let srcContent: string;
let refCommitHash: string | undefined;

async function run() {
  core.startGroup(`Generate storage layout of contract "${contract}" using foundry forge`);

  core.info(`Starting directory: ${process.cwd()}`);
  try {
    process.chdir(baseDir);
    core.info(`New directory: ${process.cwd()}`);
  } catch (err) {
    core.error(`chdir: ${err}`);
  }

  core.info(`Start forge process`);
  const cmpContent = createLayout(contract);
  core.info(`Parse generated layout`);
  const cmpLayout = parseLayout(cmpContent);
  core.endGroup();

  try {
    const localReportPath = resolve(outReport);
    fs.writeFileSync(localReportPath, cmpContent);

    core.startGroup(`Upload new report from "${localReportPath}" as artifact named "${outReport}"`);
    const uploadResponse = await artifactClient.uploadArtifact(
      outReport,
      [localReportPath],
      dirname(localReportPath),
      { continueOnError: false }
    );

    if (uploadResponse.failedItems.length > 0)
      throw Error("Failed to upload storage layout report.");

    core.info(`Artifact ${uploadResponse.artifactName} has been successfully uploaded!`);
  } catch (error: any) {
    return core.setFailed(error.message);
  }
  core.endGroup();

  // cannot use artifactClient because downloads are limited to uploads in the same workflow run
  // cf. https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts#downloading-or-deleting-artifacts
  let artifactId: number | null = null;
  if (context.eventName === "pull_request") {
    try {
      core.startGroup(
        `Searching artifact "${baseReport}" on repository "${repository}", on branch "${baseBranch}"`
      );
      // Note that the artifacts are returned in most recent first order.
      for await (const res of octokit.paginate.iterator(octokit.rest.actions.listArtifactsForRepo, {
        owner,
        repo,
      })) {
        const artifact = res.data.find(
          (artifact) => !artifact.expired && artifact.name === baseReport
        );
        if (!artifact) {
          await new Promise((resolve) => setTimeout(resolve, 800)); // avoid reaching the API rate limit

          continue;
        }

        artifactId = artifact.id;
        refCommitHash = artifact.workflow_run?.head_sha;
        core.info(
          `Found artifact named "${baseReport}" with ID "${artifactId}" from commit "${refCommitHash}"`
        );
        break;
      }
      core.endGroup();

      if (artifactId) {
        core.startGroup(
          `Downloading artifact "${baseReport}" of repository "${repository}" with ID "${artifactId}"`
        );
        const res = await octokit.rest.actions.downloadArtifact({
          owner,
          repo,
          artifact_id: artifactId,
          archive_format: "zip",
        });

        // @ts-ignore data is unknown
        const zip = new Zip(Buffer.from(res.data));
        for (const entry of zip.getEntries()) {
          core.info(`Loading storage layout report from "${entry.entryName}"`);
          srcContent = zip.readAsText(entry);
        }
        core.endGroup();
      } else core.error(`No workflow run found with an artifact named "${baseReport}"`);
    } catch (error: any) {
      return core.setFailed(error.message);
    }
  }

  try {
    core.startGroup("Load storage layout reports");
    srcContent ??= cmpContent; // if no source storage layout report were loaded, defaults to the current storage layout report

    core.info(`Mapping reference storage layout report`);
    const srcLayout = parseLayout(srcContent);
    core.endGroup();

    core.startGroup("Check storage layout");
    const diffs = await checkLayouts(srcLayout, cmpLayout, {
      address,
      provider,
      checkRemovals: failOnRemoval,
    });

    if (diffs.length > 0) {
      core.info(`Parse source code`);
      const cmpDef = parseSource(contract);

      const formattedDiffs = diffs.map((diff) => {
        const formattedDiff = formatDiff(cmpDef, diff);

        const title = diffTitles[formattedDiff.type];
        const level = diffLevels[formattedDiff.type] || "error";
        core[level](formattedDiff.message, {
          title,
          file: cmpDef.path,
          startLine: formattedDiff.loc.start.line,
          endLine: formattedDiff.loc.end.line,
          startColumn: formattedDiff.loc.start.column,
          endColumn: formattedDiff.loc.end.column,
        });

        return formattedDiff;
      });

      if (
        formattedDiffs.filter((diff) => diffLevels[diff.type] === "error").length > 0 ||
        (failOnRemoval &&
          formattedDiffs.filter((diff) => diff.type === StorageLayoutDiffType.VARIABLE_REMOVED)
            .length > 0)
      )
        return core.setFailed(
          "Unsafe storage layout changes detected. Please see above for details."
        );
    }

    core.endGroup();
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
