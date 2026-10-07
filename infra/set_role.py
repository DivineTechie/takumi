"""Set custom claim role for a user in Firebase Auth.

Roles allowed: master | trainee | supervisor
Uses Application Default Credentials.
Prints only "role set" or the error, never tokens.
"""

from __future__ import annotations

import argparse
import sys

import firebase_admin
from firebase_admin import auth

ALLOWED_ROLES = {"master", "trainee", "supervisor"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Set custom user role claim in Firebase Auth")
    parser.add_argument("identifier", help="User UID or email address")
    parser.add_argument("role", help="Role: master | trainee | supervisor")
    args = parser.parse_args()

    if args.role not in ALLOWED_ROLES:
        print(f"Error: Invalid role '{args.role}'. Must be one of: {', '.join(sorted(ALLOWED_ROLES))}", file=sys.stderr)
        sys.exit(1)

    try:
        if not firebase_admin._apps:
            firebase_admin.initialize_app()
        try:
            user = auth.get_user(args.identifier)
        except Exception:
            user = auth.get_user_by_email(args.identifier)
        auth.set_custom_user_claims(user.uid, {"role": args.role})
        print("role set")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
