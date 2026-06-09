import type { Command } from "commander";
import * as prompts from "../../lib/prompts.js";
import {
  getRazorpayPaymentsConfig,
  getStripePaymentsConfig,
  removeRazorpayKeys,
  removeStripeSecretKey,
  setRazorpayKeys,
  setStripeSecretKey,
} from "../../lib/api/payments.js";
import type { PaymentProvider } from "@insforge/shared-schemas";
import { requireAuth } from "../../lib/credentials.js";
import { CLIError, getRootOpts, handleError } from "../../lib/errors.js";
import { outputJson, outputSuccess, outputTable } from "../../lib/output.js";
import { parseEnvironment, trackPaymentUsage } from "./utils.js";

function outputStripeConfigTable(
  data: Awaited<ReturnType<typeof getStripePaymentsConfig>>,
): void {
  if (data.keys.length === 0) {
    console.log("No Stripe keys configured.");
    return;
  }

  outputTable(
    ["Env", "Configured", "Key"],
    data.keys.map((key) => [
      key.environment,
      key.hasKey ? "Yes" : "No",
      key.maskedKey ?? "-",
    ]),
  );
}

function outputRazorpayConfigTable(
  data: Awaited<ReturnType<typeof getRazorpayPaymentsConfig>>,
): void {
  if (data.razorpayKeys.length === 0) {
    console.log("No Razorpay keys configured.");
    return;
  }

  outputTable(
    ["Env", "Type", "Configured", "Key"],
    data.razorpayKeys.map((key) => [
      key.environment,
      key.keyType,
      key.hasKey ? "Yes" : "No",
      key.maskedKey ?? "-",
    ]),
  );
}

export function registerPaymentsConfigCommand(
  paymentsCmd: Command,
  provider: PaymentProvider,
): void {
  const configCmd = paymentsCmd
    .command("config")
    .description("Manage payment provider keys");

  configCmd
    .command("list")
    .description("List configured payment provider keys")
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (provider === "stripe") {
          const data = await getStripePaymentsConfig();
          if (json) {
            outputJson(data);
          } else {
            outputStripeConfigTable(data);
          }
        } else {
          const data = await getRazorpayPaymentsConfig();
          if (json) {
            outputJson(data);
          } else {
            outputRazorpayConfigTable(data);
          }
        }

        await trackPaymentUsage("config", true, { provider });
      } catch (err) {
        await trackPaymentUsage("config", false, { provider }, err);
        handleError(err, json);
      }
    });

  if (provider === "stripe") {
    registerStripeConfigSetCommand(configCmd);
  } else {
    registerRazorpayConfigSetCommand(configCmd);
  }

  configCmd
    .command("remove")
    .description("Remove configured payment provider keys")
    .requiredOption(
      "--environment <environment>",
      "Payment environment: test or live",
    )
    .action(async (opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        if (json && !yes) {
          throw new CLIError(
            "Use --yes with --json to remove payment keys non-interactively.",
          );
        }

        if (!yes) {
          const confirm = await prompts.confirm({
            message: `Remove ${provider} ${environment} keys? Payment sync and mutations for this environment will stop.`,
          });
          if (prompts.isCancel(confirm) || !confirm) process.exit(0);
        }

        const data =
          provider === "stripe"
            ? await removeStripeSecretKey(environment)
            : await removeRazorpayKeys(environment);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`${provider} ${environment} keys removed.`);
        }

        await trackPaymentUsage("config.remove", true, {
          provider,
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "config.remove",
          false,
          {
            provider,
            environment: opts.environment,
          },
          err,
        );
        handleError(err, json);
      }
    });
}

function registerStripeConfigSetCommand(configCmd: Command): void {
  configCmd
    .command("set [secretKey]")
    .description("Configure a Stripe secret key for test or live payments")
    .requiredOption(
      "--environment <environment>",
      "Stripe environment: test or live",
    )
    .option("--secret-key <secretKey>", "Stripe secret key")
    .action(async (secretKeyValue: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        let secretKey = opts.secretKey ?? secretKeyValue;
        if (!secretKey) {
          if (json) {
            throw new CLIError(
              "Provide secretKey or --secret-key when using --json.",
            );
          }

          const input = await prompts.password({
            message: `Stripe ${environment} secret key`,
          });
          if (prompts.isCancel(input)) process.exit(0);
          secretKey = input;
        }

        const data = await setStripeSecretKey(environment, secretKey);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe ${environment} key configured.`);
        }

        await trackPaymentUsage("config.set", true, {
          provider: "stripe",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "config.set",
          false,
          {
            provider: "stripe",
            environment: opts.environment,
          },
          err,
        );
        handleError(err, json);
      }
    });
}

function registerRazorpayConfigSetCommand(configCmd: Command): void {
  configCmd
    .command("set")
    .description("Configure Razorpay keys for test or live payments")
    .requiredOption(
      "--environment <environment>",
      "Razorpay environment: test or live",
    )
    .option("--key-id <keyId>", "Razorpay key id")
    .option("--key-secret <keySecret>", "Razorpay key secret")
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        let keyId: string | undefined = opts.keyId;
        let keySecret: string | undefined = opts.keySecret;
        if (!keyId) {
          if (json) {
            throw new CLIError("Provide --key-id when using --json.");
          }

          const input = await prompts.text({
            message: `Razorpay ${environment} key id`,
          });
          if (prompts.isCancel(input)) process.exit(0);
          keyId = input;
        }
        if (!keySecret) {
          if (json) {
            throw new CLIError("Provide --key-secret when using --json.");
          }

          const input = await prompts.password({
            message: `Razorpay ${environment} key secret`,
          });
          if (prompts.isCancel(input)) process.exit(0);
          keySecret = input;
        }

        const data = await setRazorpayKeys(environment, {
          keyId,
          keySecret,
        });

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Razorpay ${environment} keys configured.`);
        }

        await trackPaymentUsage("config.set", true, {
          provider: "razorpay",
          environment,
        });
      } catch (err) {
        await trackPaymentUsage(
          "config.set",
          false,
          {
            provider: "razorpay",
            environment: opts.environment,
          },
          err,
        );
        handleError(err, json);
      }
    });
}
