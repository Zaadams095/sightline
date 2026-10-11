package onvif

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
)

// node is a parsed XML element. ONVIF answers are machine-generated, but every vendor picks its
// own namespace prefixes, so lookups go by local name and ignore the prefix (like the app's
// onvif-soap.ts extractors).
type node struct {
	Space, Local string
	Attrs        map[string]string // by local name
	Children     []*node
	text         strings.Builder // character data directly inside this element
}

// parseXML reads a whole document into a tree rooted at a synthetic node.
func parseXML(data []byte) (*node, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	// Some cameras declare ISO-8859-1 or similar; the parts we read are ASCII.
	d.CharsetReader = func(_ string, r io.Reader) (io.Reader, error) { return r, nil }
	root := &node{}
	stack := []*node{root}
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &node{Space: t.Name.Space, Local: t.Name.Local, Attrs: map[string]string{}}
			for _, a := range t.Attr {
				if a.Name.Space == "xmlns" || a.Name.Local == "xmlns" {
					continue
				}
				n.Attrs[a.Name.Local] = a.Value
			}
			parent := stack[len(stack)-1]
			parent.Children = append(parent.Children, n)
			stack = append(stack, n)
		case xml.EndElement:
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			stack[len(stack)-1].text.Write(t)
		}
	}
	return root, nil
}

// find returns the first descendant (depth-first, document order) with this local name.
func (n *node) find(local string) *node {
	if n == nil {
		return nil
	}
	for _, c := range n.Children {
		if c.Local == local {
			return c
		}
		if f := c.find(local); f != nil {
			return f
		}
	}
	return nil
}

// findAll returns the outermost descendants with this local name, in document order.
func (n *node) findAll(local string) []*node {
	if n == nil {
		return nil
	}
	var out []*node
	for _, c := range n.Children {
		if c.Local == local {
			out = append(out, c)
			continue
		}
		out = append(out, c.findAll(local)...)
	}
	return out
}

// child returns the first direct child with this local name.
func (n *node) child(local string) *node {
	if n == nil {
		return nil
	}
	for _, c := range n.Children {
		if c.Local == local {
			return c
		}
	}
	return nil
}

// allText is the trimmed text of the element and everything inside it.
func (n *node) allText() string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	var walk func(*node)
	walk = func(x *node) {
		b.WriteString(x.text.String())
		for _, c := range x.Children {
			walk(c)
		}
	}
	walk(n)
	return strings.TrimSpace(b.String())
}

// textOf is the trimmed text of the first descendant with this local name ("" when missing).
func (n *node) textOf(local string) string { return n.find(local).allText() }

// attr is an attribute by local name ("" when n is nil or it's missing).
func (n *node) attr(name string) string {
	if n == nil {
		return ""
	}
	return n.Attrs[name]
}

// marshal writes the element back out with its namespace declared on itself, so it stays valid
// when copied into another document (WS-Addressing reference parameters).
func (n *node) marshal(b *strings.Builder) {
	b.WriteString("<" + n.Local)
	if n.Space != "" {
		b.WriteString(` xmlns="` + escapeXML(n.Space) + `"`)
	}
	for k, v := range n.Attrs {
		b.WriteString(" " + k + `="` + escapeXML(v) + `"`)
	}
	b.WriteString(">")
	b.WriteString(escapeXML(n.text.String()))
	for _, c := range n.Children {
		c.marshal(b)
	}
	b.WriteString("</" + n.Local + ">")
}

func escapeXML(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
