#!/bin/sh
# Forced-command wrapper for the Proxmox MCP host diagnostics (decision D7, rule R10).
#
# Install on the Proxmox host as /usr/local/bin/mcp-diag.sh (root:root, mode 755) and bind the
# MCP's SSH key to it in /root/.ssh/authorized_keys:
#   command="/usr/local/bin/mcp-diag.sh",restrict,from="<mcp-machine-ip>" ssh-ed25519 AAAA... proxmox-mcp
#
# sshd puts the client's requested command in SSH_ORIGINAL_COMMAND. It must equal exactly one
# of the names below. Nothing from the client is ever interpolated into a command line.
# Keep the names in sync with host/commands.yaml: a test checks they are equal.

set -u

DATA_MOUNT=/mnt/data
TEST_MIB=2048

if [ "$#" -ne 0 ]; then
  echo "mcp-diag: arguments are not accepted" >&2
  exit 2
fi

speed_test() {
  if ! mountpoint -q "$DATA_MOUNT"; then
    echo "mcp-diag: $DATA_MOUNT is not a mount point; refusing to write on the root filesystem" >&2
    return 1
  fi
  avail_kib=$(df --output=avail -k "$DATA_MOUNT" | tail -n 1 | tr -d ' ')
  if [ "$avail_kib" -lt $((TEST_MIB * 2 * 1024)) ]; then
    echo "mcp-diag: less than $((TEST_MIB * 2)) MiB free on $DATA_MOUNT; refusing" >&2
    return 1
  fi
  f="$DATA_MOUNT/.mcp-diag-speedtest.$$"
  trap 'rm -f "$f"' EXIT HUP INT TERM
  echo "write ${TEST_MIB} MiB (direct I/O, fsync):"
  dd if=/dev/zero of="$f" bs=1M count="$TEST_MIB" oflag=direct conv=fsync 2>&1 | tail -n 1
  echo "read ${TEST_MIB} MiB (direct I/O):"
  dd if="$f" of=/dev/null bs=1M iflag=direct 2>&1 | tail -n 1
}

ethtool_all() {
  found=0
  for dev in /sys/class/net/*/device; do
    [ -e "$dev" ] || continue
    nic=$(basename "$(dirname "$dev")")
    found=1
    echo "== $nic"
    ethtool "$nic" 2>&1 | grep -E 'Settings for|Speed:|Duplex:|Auto-negotiation:|Link detected:'
  done
  [ "$found" -eq 1 ] || echo "no physical network interfaces found"
}

case "${SSH_ORIGINAL_COMMAND:-}" in
  lsblk) lsblk -o NAME,TYPE,SIZE,ROTA,TRAN,MODEL,FSTYPE,MOUNTPOINTS ;;
  df) df -hT ;;
  findmnt) findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS ;;
  ethtool) ethtool_all ;;
  ip_link_stats) ip -s link ;;
  disk_speed_test) speed_test ;;
  *)
    echo "mcp-diag: command not allowed" >&2
    exit 2
    ;;
esac
