# Build a static musl binary so the final image needs no libc.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM gcr.io/distroless/static
COPY --from=build /src/target/release/paperless-upload-proxy /paperless-upload-proxy
EXPOSE 8080
ENTRYPOINT ["/paperless-upload-proxy"]
