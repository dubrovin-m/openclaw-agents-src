# Task tools

## Executable

`/home/dubrovin/.local/bin/taskctl`

## Commands

- `taskctl inbox add`
- `taskctl inbox list`
- `taskctl inbox get`
- `taskctl inbox discard`
- `taskctl inbox commit`
- `taskctl task create`
- `taskctl task list`
- `taskctl task get`
- `taskctl task update`
- `taskctl task complete`
- `taskctl task cancel`

`TASKCTL_PAYLOAD` обязателен. Результат возвращается как JSON в stdout. Mutations требуют `operation_key`. Direct SQLite запрещён.
