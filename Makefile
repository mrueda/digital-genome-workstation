.PHONY: test build check smoke-braf

test:
	cargo test -p dgw-core
	npm test

build:
	npm run build

check: test build

smoke-braf:
	cargo run -p dgw-core --example local_smoke -- fixtures/braf-v600e.synthetic.vcf DGW_DEMO /tmp/dgw-braf-demo config/local-hs37d5.development.json

