# -*- coding: utf-8 -*-
"""孔孟智能体 · 备课 Agent 模块（Qoder Agent SDK 集成）。

模块结构：
    prompts.py      备课 Agent 系统提示词（完全替换模式，非编程 Agent）
    bus_tools.py    学情数据总线 MCP 工具（进程内，只读）
    qoder_agent.py  QoderAgentRunner（真引擎）+ MockPrepAgent（离线回退）+ 引擎选择
"""
