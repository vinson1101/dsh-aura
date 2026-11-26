#!/bin/sh
# Aura QuickTalk SSH tunnel askpass helper.
# Reads the SSH password from the login Keychain at runtime. No credential is stored here.
exec /usr/bin/security find-generic-password -s aura-quicktalk-ssh -a ubuntuli -w
