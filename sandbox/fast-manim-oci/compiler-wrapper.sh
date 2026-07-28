#!/bin/sh
set -eu

case "${0##*/}" in
  c++) compiler=/usr/bin/g++ ;;
  cc) compiler=/usr/bin/gcc ;;
  *) exit 64 ;;
esac

exec "$compiler" \
  "-fdebug-prefix-map=$PWD=." \
  "-ffile-prefix-map=$PWD=." \
  "-fmacro-prefix-map=$PWD=." \
  "$@"
