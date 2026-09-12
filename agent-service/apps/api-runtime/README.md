SessionStore
= 保存“会话发生过什么”

TurnStore
= 保存“一次执行进行到哪里”

TurnExecutionContextStore
= 保存“恢复执行需要哪些最小外部输入”

TurnStreamHub
= 保存“当前进程里实时展示什么”

SessionRunCoordinator
= 控制“同一个 Session 能否并发执行”

ExecuteTurn
= 启动一个新 Turn

ResumeTurn
= 恢复一个未完成 Turn

RecoverTurnsOnStartup
= 启动时批量调用 ResumeTurn