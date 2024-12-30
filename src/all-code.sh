#!/usr/bin/env bash

CHUNK_SIZE=1572864
rm -f all_code_part*.md

# Collect `.ts` files in an array without mapfile.
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find . -type f -name "*.ts")

if [ ${#files[@]} -eq 0 ]; then
  echo "No .ts files found."
  exit 0
fi

current_size=0
part_number=1
output_file="all_code_part${part_number}.md"
> "$output_file"

for f in "${files[@]}"; do
  f_size=$(wc -c < "$f" | tr -d ' ')
  if [ $((current_size + f_size)) -gt $CHUNK_SIZE ]; then
    part_number=$((part_number + 1))
    output_file="all_code_part${part_number}.md"
    > "$output_file"
    current_size=0
  fi

  echo "## ${f}" >> "$output_file"
  echo "" >> "$output_file"
  echo "\`\`\`typescript" >> "$output_file"
  cat "$f" >> "$output_file"
  echo "\`\`\`" >> "$output_file"
  echo "" >> "$output_file"

  current_size=$((current_size + f_size))
done

echo "Files have been split into ${part_number} parts."
