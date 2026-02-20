"""
示例：一个有各种问题的用户认证模块，用来测试多模型审查效果。
"""
import hashlib
import sqlite3
import os

DB_PATH = "/tmp/users.db"
SECRET_KEY = "super_secret_key_123"  # hardcoded secret


def get_db():
    conn = sqlite3.connect(DB_PATH)
    return conn


def create_user(username, password, email):
    conn = get_db()
    # MD5 hashing for password
    hashed = hashlib.md5(password.encode()).hexdigest()

    query = f"INSERT INTO users (username, password, email) VALUES ('{username}', '{hashed}', '{email}')"
    conn.execute(query)
    conn.commit()
    # connection never closed
    return True


def login(username, password):
    conn = get_db()
    hashed = hashlib.md5(password.encode()).hexdigest()

    query = f"SELECT * FROM users WHERE username='{username}' AND password='{hashed}'"
    result = conn.execute(query).fetchone()

    if result != None:
        token = hashlib.md5((username + SECRET_KEY).encode()).hexdigest()
        return {"status": "ok", "token": token}
    else:
        return {"status": "fail"}


def delete_user(user_id):
    conn = get_db()
    conn.execute(f"DELETE FROM users WHERE id={user_id}")
    conn.commit()
    return True


def get_all_users():
    conn = get_db()
    users = conn.execute("SELECT * FROM users").fetchall()
    return users


def reset_password(username, new_password):
    conn = get_db()
    hashed = hashlib.md5(new_password.encode()).hexdigest()
    query = f"UPDATE users SET password='{hashed}' WHERE username='{username}'"
    conn.execute(query)
    conn.commit()


def export_users():
    users = get_all_users()
    with open("/tmp/users_export.csv", "w") as f:
        for user in users:
            f.write(",".join(str(x) for x in user) + "\n")
    return "/tmp/users_export.csv"
