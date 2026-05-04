#!/usr/bin/env node

// A lot of this script is modeled after https://github.com/BetaHuhn/repo-file-sync-action/.
// This can be thought of as a stripped down version with a couple of tweaks.

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'

const token = process.env.GH_TOKEN
const org = process.env.ORG
const sourceRepo = process.env.SOURCE_REPO
const licenseFileName = 'LICENSE.md'
const gitUsername = process.env.GIT_USERNAME
const gitEmail = process.env.GIT_EMAIL
const branchPrefix = 'repo-sync/SOURCE_REPO_NAME'
const targetRepos = JSON.parse(process.env.TARGET_REPOS_JSON)

// Octokit is the main API tool for HTTPS requests
const Octokit = Octokit.plugin(throttling)

const octokit = new Octokit({
    auth: token,
    baseUrl: 'https://api.github.com',
    throttle: {
        onRateLimit: (retryAfter) => {
            core.debug(`Hit rate limit, retrying after ${retryAfter}s`)
            return true
        },
        onSecondaryRateLimit: (retryAfter) => {
            core.debug(`Hit secondary rate limit, retrying after ${retryAfter}s`)
            return true
        }
    }
})

const api = octokit.rest

// Big Git instance for managing each target repository
class Git {
    constructor({ repo, token, sourceRepo, branchPrefix, gitUsername, gitEmail }) {
        this.repo = repo
        this.token = token
        this.sourceRepo = sourceRepo
        this.branchPrefix = branchPrefix
        this.gitUsername = gitUsername
        this.gitEmail = gitEmail

        this.existingPr = undefined
        this.prBranch = undefined
        this.baseBranch = undefined
        this.workingDir = path.join(os.tmpdir(), `license-sync-${repo.owner}-${repo.name}-${Date.now()}`)
        this.gitUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`
    }

    async initRepo() {
        await this.clone()
        await this.setVanityUsernameAndEmail()
        await this.getBaseBranch()
        await this.getLastCommitSha()
    }

    async clone() {
        const branchArg = this.repo.default_branch
            ? ['--branch', this.repo.default_branch]
            : []

        await execCmd(
            [
                'git clone --depth 1',
                ...branchArg.map((v) => shQuote(v)),
                shQuote(this.gitUrl),
                shQuote(this.workingDir),
            ].join(' '),
            undefined,
            true
        )
    }

    async setVanityUsernameAndEmail() {
        await execCmd(
            `git config --local user.name ${shQuote(this.gitUsername)} && git config --local user.email ${shQuote(this.gitEmail)}`,
            this.workingDir
        )
    }

    async getBaseBranch() {
        this.baseBranch = await execCmd(`git rev-parse --abbrev-ref HEAD`, this.workingDir)
    }

    async getLastCommitSha() {
        this.lastCommitSha = await execCmd(`git rev-parse HEAD`, this.workingDir)
    }

    async createPrBranch() {
        const prefix = this.branchPrefix.replace('SOURCE_REPO_NAME', this.sourceRepo)
        this.prBranch = path.posix.join(prefix, this.repo.default_branch || 'default')

        await execCmd(`git checkout -b ${shQuote(this.prBranch)}`, this.workingDir)
    }

    async addFile(file) {
        await execCmd(`git add -f ${shQuote(file)}`, this.workingDir)
    }

    async hasChanges() {
        const output = await execCmd(`git status --porcelain`, this.workingDir)
        return output.trim().length !== 0
    }

    async commit(message) {
        await execCmd(`git commit -m ${shQuote(message)}`, this.workingDir)
    }

    async push() {
        await execCmd(`git push origin ${shQuote(this.prBranch)} --force`, this.workingDir)
    }

    async findExistingPr() {
        const { data } = await api.pulls.list({
            owner: this.repo.owner,
            repo: this.repo.name,
            state: 'open',
            head: `${this.repo.owner}:${this.prBranch}`
        })
        return data[0] ?? null
    }

    async createOrUpdatePr(title, body) {
        const payload = {
            title,
            body,
            head: this.prBranch,
            base: this.baseBranch,
            maintainer_can_modify: true
        }

        const existingPr = await this.findExistingPr()
        if (existingPr) {
            const { data } = await api.pulls.update({
                owner: this.repo.owner,
                repo: this.repo.name,
                pull_number: existingPr.number,
                ...payload
            })
            return data
        }

        const { data } = await api.pulls.create({
            owner: this.repo.owner,
            repo: this.repo.name,
            ...payload
        })
        return data
    }
}



async function awaitForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array)
    }
}

function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function execCmd(command, workingDir, trimResult = true) {
    return new Promise((resolve, reject) => {
        exec(
            command,
            { cwd: workingDir, maxBuffer: 1024 * 1024 * 8 },
            (error, stdout, stderr) => {
                if (error) {
                    const details = [
                        `Command failed: ${command}`,
                        stdout ? `stdout:\n${stdout}` : '',
                        stderr ? `stderr:\n${stderr}` : '',
                    ].filter(Boolean).join('\n\n')
                    reject(new Error(details))
                    return
                }
                resolve(trimResult ? stdout.trim() : stdout)
            }
        )
    })
}

async function removeDir(src) {
    await fs.rm(src, { recursive: true, force: true })
}



async function run() {
    const sourceLicense = await fs.readFile(licenseFileName, 'utf8')

    await awaitForEach(targetRepos, async (repo) => {
        const git = new Git({
            repo,
            token,
            sourceRepo,
            branchPrefix,
            gitUsername,
            gitEmail,
        })

        try {
            await git.initRepo()
            await git.createPrBranch()

            const destAbsPath = path.join(git.workingDir, licenseFileName)
            await fs.mkdir(path.dirname(destAbsPath), { recursive: true })

            await fs.writeFile(destAbsPath, sourceLicense, 'utf8')
            await git.addFile(licenseFileName)

            if (!(await git.hasChanges())) {
                await removeDir(git.workingDir)
                return
            }

            const commitMessage = `Update '${licenseFileName}' from ${sourceRepo}`
            await git.commit(commitMessage)
            await git.push()

            const prTitle = `Update '${licenseFileName}'`
            const prBody = `This PR was created automatically due to a file change in [${sourceRepo}](${process.env.GITHUB_SERVER_URL}/${sourceRepo}).`

            const pr = await git.createOrUpdatePr(prTitle, prBody)

            await removeDir(git.workingDir)
        } catch (err) {
            console.error(`Failed for ${repo.full_name}: ${err.message}`)
            await removeDir(git.workingDir)
        }
    })
}



run()
    .catch((err) => {
        core.setFailed(err.message)
        core.debug(err)
    })