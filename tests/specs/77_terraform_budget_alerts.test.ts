import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const MODULE_DIR = resolve(ROOT, 'terraform/modules/budget');
const EXAMPLE_DIR = resolve(ROOT, 'terraform/examples/budget');
const TERRAFORM_ROOT = resolve(ROOT, 'terraform');

function runTerraform(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('terraform', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 240_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			TF_IN_AUTOMATION: '1',
			TF_INPUT: '0',
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function terraformAvailable(): boolean {
	const result = spawnSync('terraform', ['version'], {
		encoding: 'utf-8',
		timeout: 10_000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return (result.status ?? 1) === 0;
}

function createTerraformSandbox(): { root: string; exampleDir: string } {
	const root = mkdtempSync(resolve(tmpdir(), 'mulder-budget-'));

	mkdirSync(resolve(root, 'terraform/modules'), { recursive: true });
	mkdirSync(resolve(root, 'terraform/examples'), { recursive: true });

	cpSync(MODULE_DIR, resolve(root, 'terraform/modules/budget'), { recursive: true });
	cpSync(EXAMPLE_DIR, resolve(root, 'terraform/examples/budget'), { recursive: true });

	return {
		root,
		exampleDir: resolve(root, 'terraform/examples/budget'),
	};
}

const TERRAFORM_INSTALLED = terraformAvailable();

describe('Spec 77 — Terraform Budget Alerts', () => {
	it('QA-01: the reusable budget module exists and exposes the required inputs', () => {
		const expectedFiles = ['main.tf', 'variables.tf', 'outputs.tf'];

		for (const file of expectedFiles) {
			expect(existsSync(resolve(MODULE_DIR, file)), `Missing module file: ${file}`).toBe(true);
		}

		const variables = readFileSync(resolve(MODULE_DIR, 'variables.tf'), 'utf-8');
		expect(variables).toContain('variable "billing_account"');
		expect(variables).toContain('variable "project_name"');
		expect(variables).toContain('variable "monthly_budget_usd"');
	});

	it('QA-02: the module encodes the exact §16.1 budget contract', () => {
		const mainTf = readFileSync(resolve(MODULE_DIR, 'main.tf'), 'utf-8');

		expect(mainTf.match(/resource\s+"google_billing_budget"\s+"mulder"/g) ?? []).toHaveLength(1);
		expect(mainTf).toContain('billing_account = var.billing_account');
		expect(mainTf).toContain(`display_name    = "mulder-\${var.project_name}"`);
		expect(mainTf).toContain('currency_code = "USD"');
		expect(mainTf).toContain('units         = var.monthly_budget_usd');
		expect(mainTf).toContain('threshold_percent = 0.5');
		expect(mainTf).toContain('threshold_percent = 0.9');
		expect(mainTf).not.toContain('notification_channel');
		expect(mainTf).not.toContain('pubsub');
		expect(mainTf).not.toContain('google_monitoring');
	});

	it.skipIf(!TERRAFORM_INSTALLED)('QA-03: the standalone example initializes and validates cleanly', () => {
		const sandbox = createTerraformSandbox();

		try {
			const initResult = runTerraform(['init', '-backend=false'], sandbox.exampleDir);
			expect(initResult.exitCode, `${initResult.stdout}\n${initResult.stderr}`).toBe(0);

			const validateResult = runTerraform(['validate'], sandbox.exampleDir);
			expect(validateResult.exitCode, `${validateResult.stdout}\n${validateResult.stderr}`).toBe(0);
		} finally {
			rmSync(sandbox.root, { recursive: true, force: true });
		}
	});

	it.skipIf(!TERRAFORM_INSTALLED)('QA-04: Terraform formatting stays clean', () => {
		const fmtResult = runTerraform(['fmt', '-check', '-recursive', 'terraform'], ROOT);
		expect(fmtResult.exitCode, `${fmtResult.stdout}\n${fmtResult.stderr}`).toBe(0);
	});

	it('QA-05: the step stays narrowly scoped to budget alerts', () => {
		const moduleMain = readFileSync(resolve(MODULE_DIR, 'main.tf'), 'utf-8');
		const exampleMain = readFileSync(resolve(EXAMPLE_DIR, 'main.tf'), 'utf-8');

		expect(moduleMain).not.toContain('resource "google_storage_bucket"');
		expect(moduleMain).not.toContain('resource "google_pubsub_topic"');
		expect(moduleMain).not.toContain('resource "google_monitoring_notification_channel"');
		expect(moduleMain).not.toContain('resource "google_project"');
		expect(exampleMain).toContain('source = "../../modules/budget"');
		expect(existsSync(resolve(TERRAFORM_ROOT, 'modules/budget'))).toBe(true);
		expect(existsSync(resolve(TERRAFORM_ROOT, 'examples/budget'))).toBe(true);
	});
});
