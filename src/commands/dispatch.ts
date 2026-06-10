import { Command } from "commander";
import { tick, startDispatcher } from "../dispatcher";

export const dispatchCommand = new Command("dispatch")
  .description("Dispatch ready tasks to agents")
  .option("--interval <ms>", "Poll interval in milliseconds")
  .action(async (options: { interval?: string }) => {
    const interval = options.interval ? parseInt(options.interval, 10) : undefined;
    
    if (interval !== undefined) {
      if (isNaN(interval) || interval <= 0) {
        console.error("Invalid interval. Must be a positive number.");
        process.exit(1);
      }
      
      console.log(`Starting dispatcher with ${interval}ms interval...`);
      const dispatcher = startDispatcher(interval);
      
      process.on("SIGINT", () => {
        console.log("\nStopping dispatcher...");
        dispatcher.stop();
        process.exit(0);
      });
      
      process.on("SIGTERM", () => {
        dispatcher.stop();
        process.exit(0);
      });
    } else {
      try {
        const result = await tick();
        console.log(`Dispatched ${result.processed} task(s)`);
      } catch (err: any) {
        console.error("Dispatch failed:", err.message);
        process.exit(1);
      }
    }
  });
