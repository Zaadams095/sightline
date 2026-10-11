FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /sightline-bridge .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 bridge && mkdir /data && chown bridge /data
USER bridge
COPY --from=build /sightline-bridge /usr/local/bin/sightline-bridge
VOLUME /data
EXPOSE 8086
ENTRYPOINT ["sightline-bridge"]
