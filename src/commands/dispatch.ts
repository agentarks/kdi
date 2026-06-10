import { Command } from "commander";
import { startDispatcher } from "../dispatcher";

export const dispatchCommand = new Command("dispatch")
  .description("Dispatch ready tasks to agents")
  .option("--interval <ms>", "Poll interval in milliseconds", "5000")
  .action(async (options: { interval: string }) => {
    const interval = parseInt(options.interval, 10);
    
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
  });
