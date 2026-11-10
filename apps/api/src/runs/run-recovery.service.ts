import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import {
  RUN_EXECUTION_STORE,
  type RunExecutionStore,
} from "./run-execution.store.js";

/** 单实例启动时将旧进程遗留的活跃运行标为 INTERRUPTED，不能假装继续执行。 */
@Injectable()
export class RunRecoveryService implements OnModuleInit {
  constructor(
    @Inject(RUN_EXECUTION_STORE)
    private readonly store: Pick<RunExecutionStore, "recover">,
  ) {}
  async onModuleInit(): Promise<void> {
    await this.store.recover();
  }
}
