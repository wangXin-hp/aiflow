import { Injectable } from "@nestjs/common";
import { Subject, filter, map, type Observable } from "rxjs";

/** 通知只承载运行 ID；订阅者总是再查已提交的数据库事件。 */
@Injectable()
export class RunEventHub {
  private readonly notificationsSubject = new Subject<string>();

  notifications(runId: string): Observable<void> {
    return this.notificationsSubject.pipe(
      filter((notifiedRunId) => notifiedRunId === runId),
      map(() => undefined),
    );
  }

  notify(runId: string): void {
    this.notificationsSubject.next(runId);
  }
}
