"""Validators shared by the launcher, the binding and the package installer (stdlib only)."""
import re

ACCOUNT = re.compile(r'[a-z0-9][a-z0-9_.-]{0,127}')
APP_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{1,127}')
DEFAULT_LIVEWARE = '/opt/clawnest/bin/liveware'


def valid_executable(value):
    return (isinstance(value, str) and re.fullmatch(r'/[A-Za-z0-9_./-]{1,255}', value) is not None
            and '..' not in value.split('/'))


def normalize_account(value):
    """The plugin passes the lowercased agent id as the Liveware account."""
    return value.lower() if isinstance(value, str) else value


def valid_account(value):
    return isinstance(value, str) and ACCOUNT.fullmatch(value) is not None
