import asyncio
import json
from typing import Set
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["websocket"])

_connections: Set[WebSocket] = set()


async def broadcast(message: dict):
    """모든 연결된 WebSocket 클라이언트에 메시지 전송"""
    if not _connections:
        return
    data = json.dumps(message, ensure_ascii=False, default=str)
    dead = set()
    for ws in list(_connections):
        try:
            await ws.send_text(data)
        except Exception:
            dead.add(ws)
    _connections.difference_update(dead)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    _connections.add(websocket)
    try:
        while True:
            # Keep-alive: echo back any client message
            data = await websocket.receive_text()
            await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        _connections.discard(websocket)
    except Exception:
        _connections.discard(websocket)
